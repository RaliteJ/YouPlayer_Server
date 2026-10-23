package main

import (
	"crypto/ed25519"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

type fakeDeployment struct {
	calls  []string
	fail   string
	always bool
	onCall func(string)
}

func (d *fakeDeployment) call(s string) error {
	d.calls = append(d.calls, s)
	if d.onCall != nil {
		d.onCall(s)
	}
	if d.fail == s {
		if !d.always {
			d.fail = ""
		}
		return failure("health-failed")
	}
	return nil
}
func (d *fakeDeployment) assertCurrent(images) error  { return d.call("current") }
func (d *fakeDeployment) pull(images) error           { return d.call("pull") }
func (d *fakeDeployment) activate(images, bool) error { return d.call("activate") }
func (d *fakeDeployment) healthy(images) error        { return d.call("healthy") }
func (d *fakeDeployment) resume(images) error         { return d.call("resume") }
func workerFixture(t *testing.T) (*worker, *fakeDeployment, ed25519.PrivateKey) {
	t.Helper()
	root := t.TempDir()
	pub, priv := keys(t)
	d := &fakeDeployment{}
	must(t, prepareDirectories(root))
	w := &worker{root: root, config: configuration{"podman", project, "linux/amd64"}, key: pub, deployment: d, now: time.Now, latest: func() (envelope, error) { return signed(t, sample("v2.0.0", 2), priv), nil }}
	must(t, writeJSON(w.host("release-state.json"), installedState{Envelope: signed(t, sample("v1.0.0", 1), priv)}))
	must(t, w.initialize())
	d.calls = nil
	return w, d, priv
}
func submit(t *testing.T, w *worker, action, id string) {
	t.Helper()
	must(t, writeJSON(filepath.Join(w.root, ".updates/requests/release.json"), job{"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", action, id}))
	must(t, w.tick())
}
func TestWorkerInstall(t *testing.T) {
	w, d, _ := workerFixture(t)
	submit(t, w, "install", "a")
	if w.state.Phase != "failed" || len(d.calls) != 0 {
		t.Fatal("unchecked install")
	}
	submit(t, w, "check", "")
	if w.state.Phase != "available" || len(d.calls) != 0 {
		t.Fatal(w.state)
	}
	d.onCall = func(s string) {
		if s == "activate" {
			var tx transaction
			must(t, readJSON(w.host("transaction.json"), 128*1024, &tx))
			if tx.Previous.Envelope != w.installed.Envelope {
				t.Fatal("missing previous state")
			}
		}
	}
	submit(t, w, "install", *w.state.CandidateID)
	if w.state.Phase != "installed" || w.state.InstalledVersion != "v2.0.0" {
		t.Fatal(w.state)
	}
	if !reflect.DeepEqual(d.calls, []string{"current", "pull", "current", "activate", "healthy"}) {
		t.Fatal(d.calls)
	}
	if _, err := os.Stat(w.host("transaction.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("journal retained")
	}
	var stored installedState
	must(t, readJSON(w.host("release-state.json"), 128*1024, &stored))
	if stored.Previous == nil {
		t.Fatal("previous images lost")
	}
}
func TestWorkerFailures(t *testing.T) {
	for _, stage := range []string{"pull", "activate", "healthy"} {
		t.Run(stage, func(t *testing.T) {
			w, d, _ := workerFixture(t)
			previous := w.installed
			submit(t, w, "check", "")
			d.fail = stage
			submit(t, w, "install", *w.state.CandidateID)
			expected := "rolled-back"
			if stage == "pull" {
				expected = "failed"
			}
			if w.state.Phase != expected || w.state.InstalledVersion != "v1.0.0" || !reflect.DeepEqual(w.installed, previous) {
				t.Fatal(w.state)
			}
		})
	}
}
func TestRollbackFailureAndRestart(t *testing.T) {
	w, d, _ := workerFixture(t)
	submit(t, w, "check", "")
	d.fail = "healthy"
	d.always = true
	submit(t, w, "install", *w.state.CandidateID)
	if w.state.Phase != "recovery-required" {
		t.Fatal(w.state)
	}
	var tx transaction
	must(t, readJSON(w.host("transaction.json"), 128*1024, &tx))
	calls := len(d.calls)
	submit(t, w, "check", "")
	if len(d.calls) != calls {
		t.Fatal("recovery allowed another install")
	}
	must(t, os.Remove(filepath.Join(w.root, ".updates/requests/release.json")))
	d.fail = ""
	d.calls = nil
	w.latest = func() (envelope, error) { t.Fatal("startup fetched release"); return envelope{}, nil }
	must(t, w.initialize())
	if w.state.Phase != "rolled-back" || *w.state.Failure != "interrupted" || !reflect.DeepEqual(d.calls, []string{"activate", "healthy"}) {
		t.Fatal(w.state, d.calls)
	}
}
func TestStaleCandidates(t *testing.T) {
	w, d, priv := workerFixture(t)
	submit(t, w, "check", "")
	id := *w.state.CandidateID
	w.now = func() time.Time { return time.Now().Add(31 * time.Minute) }
	submit(t, w, "install", id)
	if *w.state.Failure != "stale-candidate" {
		t.Fatal(w.state)
	}
	for _, e := range []envelope{signed(t, sample("v0.9.0", 2), priv), signed(t, sample("v1.0.0", 2), priv), {Payload: "bad", Signature: "bad"}} {
		w.latest = func() (envelope, error) { return e, nil }
		submit(t, w, "check", "")
		if w.state.Phase != "failed" {
			t.Fatal(w.state)
		}
	}
	if len(d.calls) != 0 {
		t.Fatal(d.calls)
	}
}
func TestRequestAndLockBoundaries(t *testing.T) {
	root := t.TempDir()
	must(t, prepareDirectories(root))
	file := filepath.Join(root, ".updates/requests/release.json")
	target := filepath.Join(root, "private")
	must(t, os.WriteFile(target, []byte(`{}`), 0600))
	must(t, os.Symlink(target, file))
	if _, err := readJob(file); err == nil {
		t.Fatal("symlink accepted")
	}
	must(t, os.Remove(file))
	must(t, os.WriteFile(file, make([]byte, 1025), 0600))
	if _, err := readJob(file); err == nil {
		t.Fatal("oversized job")
	}
	first, err := lockService(root)
	must(t, err)
	if second, err := lockService(root); err == nil {
		second.Close()
		t.Fatal("concurrent lock")
	}
	must(t, first.Close())
	second, err := lockService(root)
	must(t, err)
	second.Close()
}

func TestUpToDateWrongCandidateAndInvalidJob(t *testing.T) {
	w, d, _ := workerFixture(t)
	w.latest = func() (envelope, error) { return w.installed.Envelope, nil }
	submit(t, w, "check", "")
	if w.state.Phase != "up-to-date" || w.candidate != nil {
		t.Fatal(w.state)
	}
	submit(t, w, "install", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if *w.state.Failure != "stale-candidate" || len(d.calls) != 0 {
		t.Fatal(w.state, d.calls)
	}
	file := filepath.Join(w.root, ".updates/requests/release.json")
	must(t, os.WriteFile(file, []byte("not json"), 0600))
	must(t, w.tick())
	if *w.state.Failure != "invalid-request" {
		t.Fatal(w.state)
	}
}
