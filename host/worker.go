package main

import (
	"crypto/ed25519"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

type deployer interface {
	assertCurrent(images) error
	pull(images) error
	activate(images, bool) error
	healthy(images) error
	resume(images) error
}
type installedState struct {
	Envelope envelope  `json:"envelope"`
	Previous *envelope `json:"previous,omitempty"`
}
type transaction struct {
	Previous  installedState `json:"previous"`
	Candidate envelope       `json:"candidate"`
}
type status struct {
	Phase            string  `json:"phase"`
	InstalledVersion string  `json:"installedVersion"`
	LatestVersion    *string `json:"latestVersion"`
	CheckedAt        *string `json:"checkedAt"`
	CandidateID      *string `json:"candidateId"`
	Failure          *string `json:"failure"`
	RequestID        *string `json:"requestId"`
	Heartbeat        int64   `json:"heartbeat"`
}
type job struct {
	ID          string `json:"id"`
	Action      string `json:"action"`
	CandidateID string `json:"candidateId"`
}
type worker struct {
	root          string
	config        configuration
	key           ed25519.PublicKey
	deployment    deployer
	latest        func() (envelope, error)
	now           func() time.Time
	installed     installedState
	candidate     *envelope
	candidateTime time.Time
	mu            sync.Mutex
	state         status
}

func (w *worker) host(name string) string { return filepath.Join(w.root, ".updates/host", name) }
func (w *worker) refs(value installedState) (images, error) {
	m, err := verifyManifest(value.Envelope, w.key)
	return m.Platforms[w.config.Platform], err
}
func (w *worker) publish() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.state.Heartbeat = w.now().UnixMilli()
	return writeJSON(filepath.Join(w.root, ".updates/status/release.json"), w.state)
}
func (w *worker) change(fn func(*status)) error {
	w.mu.Lock()
	fn(&w.state)
	w.mu.Unlock()
	return w.publish()
}
func (w *worker) phase(p string) error { return w.change(func(s *status) { s.Phase = p }) }
func (w *worker) fail(err error, p string) error {
	c := code(err)
	return w.change(func(s *status) { s.Failure = &c; s.Phase = p; s.CandidateID = nil })
}
func (w *worker) rollback(previous installedState, recovery bool) error {
	if err := w.phase("rolling-back"); err != nil {
		return err
	}
	refs, err := w.refs(previous)
	if err != nil {
		return err
	}
	if err = w.deployment.activate(refs, recovery); err != nil {
		return err
	}
	if err = w.deployment.healthy(refs); err != nil {
		return err
	}
	if err = writeJSON(w.host("release-state.json"), previous); err != nil {
		return err
	}
	w.installed = previous
	if err = removeDurable(w.host("transaction.json")); err != nil {
		return err
	}
	m, _ := verifyManifest(previous.Envelope, w.key)
	return w.change(func(s *status) { s.InstalledVersion = m.Version; s.Phase = "rolled-back" })
}
func (w *worker) initialize() error {
	if err := readJSON(w.host("release-state.json"), 128*1024, &w.installed); err != nil {
		return err
	}
	m, err := verifyManifest(w.installed.Envelope, w.key)
	if err != nil {
		return err
	}
	w.state = status{Phase: "idle", InstalledVersion: m.Version}
	var tx transaction
	err = readJSON(w.host("transaction.json"), 128*1024, &tx)
	if err == nil {
		if err = w.rollback(tx.Previous, true); err != nil {
			return w.fail(failure("rollback-failed"), "recovery-required")
		}
		c := "interrupted"
		return w.change(func(s *status) { s.Failure = &c })
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err = w.deployment.resume(m.Platforms[w.config.Platform]); err != nil {
		return w.fail(err, "recovery-required")
	}
	return w.publish()
}
func readJob(file string) (job, error) {
	var j job
	if err := readJSON(file, 1024, &j); err != nil {
		return j, err
	}
	if !regexp.MustCompile(`^[a-f0-9-]{36}$`).MatchString(j.ID) || (j.Action != "check" && j.Action != "install") || j.Action == "install" && !digestPattern.MatchString(j.CandidateID) {
		return j, failure("invalid-request")
	}
	return j, nil
}
func (w *worker) tick() error {
	w.mu.Lock()
	blocked := w.state.Phase == "recovery-required"
	w.mu.Unlock()
	if blocked {
		return nil
	}
	file := filepath.Join(w.root, ".updates/requests/release.json")
	j, err := readJob(file)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		if e := os.Remove(file); e != nil && !errors.Is(e, os.ErrNotExist) {
			return e
		}
		return w.fail(failure("invalid-request"), "failed")
	}
	if err = os.Remove(file); err != nil {
		return err
	}
	if err = w.change(func(s *status) { s.RequestID = &j.ID; s.Failure = nil }); err != nil {
		return err
	}
	err = w.process(j)
	if err != nil {
		w.candidate = nil
		return w.fail(err, "failed")
	}
	return w.publish()
}
func (w *worker) process(j job) error {
	if j.Action == "check" {
		w.candidate = nil
		if err := w.change(func(s *status) { s.CandidateID = nil; s.LatestVersion = nil; s.Phase = "checking" }); err != nil {
			return err
		}
		e, err := w.latest()
		if err != nil {
			return err
		}
		m, err := verifyManifest(e, w.key)
		if err != nil {
			return err
		}
		current, err := verifyManifest(w.installed.Envelope, w.key)
		if err != nil {
			return err
		}
		checked := w.now().UTC().Format(time.RFC3339Nano)
		if err = w.change(func(s *status) { s.LatestVersion = &m.Version; s.CheckedAt = &checked }); err != nil {
			return err
		}
		cmp := compareVersions(m.Version, current.Version)
		if cmp == 0 && identity(e) == identity(w.installed.Envelope) {
			return w.phase("up-to-date")
		}
		if cmp <= 0 || m.Sequence <= current.Sequence {
			return failure("stale-candidate")
		}
		w.candidate = &e
		w.candidateTime = w.now()
		id := identity(e)
		return w.change(func(s *status) { s.CandidateID = &id; s.Phase = "available" })
	}
	w.mu.Lock()
	available := w.state.Phase == "available"
	w.mu.Unlock()
	if !available || w.candidate == nil || j.CandidateID != identity(*w.candidate) || w.now().Sub(w.candidateTime) > 30*time.Minute || w.now().Before(w.candidateTime) {
		return failure("stale-candidate")
	}
	m, err := verifyManifest(*w.candidate, w.key)
	if err != nil {
		return err
	}
	refs := m.Platforms[w.config.Platform]
	previousRefs, err := w.refs(w.installed)
	if err != nil {
		return err
	}
	if err = w.phase("downloading"); err != nil {
		return err
	}
	if err = w.deployment.assertCurrent(previousRefs); err != nil {
		return err
	}
	if err = w.deployment.pull(refs); err != nil {
		return err
	}
	if err = w.deployment.assertCurrent(previousRefs); err != nil {
		return err
	}
	previous := w.installed
	if err = writeJSON(w.host("transaction.json"), transaction{previous, *w.candidate}); err != nil {
		return err
	}
	// No container changes precede the durable recovery journal.
	err = func() error {
		if err := w.phase("installing"); err != nil {
			return err
		}
		if err := w.deployment.activate(refs, false); err != nil {
			return err
		}
		if err := w.phase("verifying"); err != nil {
			return err
		}
		if err := w.deployment.healthy(refs); err != nil {
			return err
		}
		next := installedState{*w.candidate, &previous.Envelope}
		if err := writeJSON(w.host("release-state.json"), next); err != nil {
			return err
		}
		if err := removeDurable(w.host("transaction.json")); err != nil {
			return err
		}
		w.installed = next
		return nil
	}()
	w.candidate = nil
	if err != nil {
		c := code(err)
		_ = w.change(func(s *status) { s.Failure = &c; s.CandidateID = nil })
		if err = w.rollback(previous, false); err != nil {
			return w.fail(failure("rollback-failed"), "recovery-required")
		}
		return nil
	}
	// Publication errors cannot roll back a transaction committed to disk.
	return w.change(func(s *status) { s.Phase = "installed"; s.InstalledVersion = m.Version; s.CandidateID = nil })
}
