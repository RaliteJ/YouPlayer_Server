package main

import (
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type engineFixture struct {
	calls                  []string
	active, wrong, stopped bool
	refs                   images
	fail                   string
	volumes                string
}

func (f *engineFixture) run(p string, a, env []string) (string, error) {
	line := p + " " + strings.Join(a, " ")
	f.calls = append(f.calls, line)
	if f.fail != "" && strings.Contains(line, f.fail) {
		return "", failure("command-failed")
	}
	if p == "loginctl" {
		return "yes", nil
	}
	if a[0] == "info" {
		if strings.Contains(a[len(a)-1], "SecurityOptions") {
			return "[]", nil
		}
		return "linux/" + runtime.GOARCH, nil
	}
	if a[0] == "volume" {
		return f.volumes, nil
	}
	if a[0] == "ps" {
		if f.active {
			return "backend-id\nfrontend-id", nil
		}
		return "", nil
	}
	if a[0] == "image" {
		return `[{"Os":"linux","Architecture":"` + runtime.GOARCH + `"}]`, nil
	}
	if a[0] == "inspect" {
		values := []container{}
		for _, s := range services {
			var c container
			c.Config.Image = f.refs[s]
			if f.wrong {
				c.Config.Image = "unexpected"
			}
			c.Config.Labels = map[string]string{"com.docker.compose.project": project, "com.docker.compose.service": s}
			c.State.Status = "running"
			if f.stopped {
				c.State.Status = "exited"
			}
			c.State.Health.Status = "healthy"
			values = append(values, c)
		}
		b, _ := json.Marshal(values)
		return string(b), nil
	}
	if strings.Contains(line, " up ") {
		f.active = true
		f.stopped = false
	}
	for _, arg := range a {
		if arg == "down" || arg == "rm" || arg == "build" || arg == "--volumes" {
			return "", errors.New("destructive command")
		}
	}
	return "", nil
}
func TestDeployment(t *testing.T) {
	for _, engine := range []string{"podman", "docker"} {
		t.Run(engine, func(t *testing.T) {
			root := t.TempDir()
			must(t, prepareEnvironment(root, "synthetic", "synthetic-password"))
			d, err := newDeployment(root, configuration{engine, project, "linux/" + runtime.GOARCH})
			must(t, err)
			f := &engineFixture{refs: sample("v1.0.0", 1).Platforms["linux/amd64"]}
			d.run = f.run
			d.wait = func(time.Duration) {}
			must(t, d.checkTools())
			must(t, d.assertFresh())
			must(t, d.pull(f.refs))
			must(t, d.initializeData(f.refs))
			must(t, d.activate(f.refs, false))
			must(t, d.healthy(f.refs))
			var override struct{ Services map[string]map[string]any }
			must(t, readJSON(filepath.Join(root, ".updates/host/images.json"), 10000, &override))
			if override.Services["backend"]["image"] != f.refs["backend"] || override.Services["redis"] != nil {
				t.Fatal(override)
			}
			joined := strings.Join(f.calls, "\n")
			if !strings.Contains(joined, "--env-file /dev/null") || !strings.Contains(joined, "up -d --no-build --no-deps backend frontend") {
				t.Fatal(joined)
			}
			if engine == "podman" && (!strings.Contains(joined, "--in-pod false") || override.Services["backend"]["userns_mode"] != "keep-id:uid=1000,gid=1000") {
				t.Fatal(override, joined)
			}
			f.stopped = true
			must(t, d.resume(f.refs))
			if f.stopped {
				t.Fatal("resume failed")
			}
			f.wrong = true
			if code(d.assertCurrent(f.refs)) != "deployment-changed" {
				t.Fatal("wrong image accepted")
			}
			f.wrong = false
			if code(d.assertFresh()) != "deployment-changed" {
				t.Fatal("existing containers accepted")
			}
			f.active = false
			f.volumes = project + "_youplayer_data"
			if code(d.assertFresh()) != "deployment-changed" {
				t.Fatal("existing data accepted")
			}
		})
	}
}
func TestEnvironmentAndLogs(t *testing.T) {
	root := t.TempDir()
	password := `synthetic $${UNSET} # " password`
	must(t, prepareEnvironment(root, "synthetic", password))
	before, err := os.ReadFile(filepath.Join(root, ".env"))
	must(t, err)
	must(t, prepareEnvironment(root, "other", "other-password"))
	after, _ := os.ReadFile(filepath.Join(root, ".env"))
	if string(before) != string(after) {
		t.Fatal("environment overwritten")
	}
	env, err := composeEnvironment(root, []string{"PATH=" + os.Getenv("PATH"), "YOUPLAYER_ADMIN_PASSWORD=wrong", "COMPOSE_FILE=wrong", "UNSET=wrong"})
	must(t, err)
	joined := "\n" + strings.Join(env, "\n") + "\n"
	if !strings.Contains(joined, "\nYOUPLAYER_ADMIN_PASSWORD="+password+"\n") || strings.Contains(joined, "COMPOSE_FILE=") {
		t.Fatal("interpolated or inherited configuration")
	}
	if _, err := exec.LookPath("podman-compose"); err == nil {
		compose := filepath.Join(root, "compose.json")
		must(t, os.WriteFile(compose, []byte(`{"services":{"backend":{"image":"synthetic","environment":{"PASSWORD":"${YOUPLAYER_ADMIN_PASSWORD}"}}}}`), 0600))
		cmd := exec.Command("podman-compose", "--env-file", "/dev/null", "-p", project, "-f", compose, "config")
		cmd.Dir = root
		cmd.Env = env
		out, err := cmd.Output()
		if err != nil {
			if e, ok := err.(*exec.ExitError); ok {
				t.Fatalf("compose config: %s", e.Stderr)
			}
			t.Fatal(err)
		}
		if !strings.Contains(string(out), "$${UNSET}") {
			t.Fatalf("Compose expanded password: %s", out)
		}
	}
	must(t, prepareDirectories(root))
	_, err = runCommand(root, "/bin/sh", []string{"-c", "echo synthetic-private >&2; exit 1"}, os.Environ())
	if code(err) != "command-failed" {
		t.Fatal(err)
	}
	log := filepath.Join(root, ".updates/host/last-command.log")
	data, err := os.ReadFile(log)
	must(t, err)
	stat, err := os.Stat(log)
	must(t, err)
	if !strings.Contains(string(data), "synthetic-private") || stat.Mode().Perm() != 0600 {
		t.Fatal("private log incorrect")
	}
	must(t, os.Chmod(filepath.Join(root, ".env"), 0644))
	if _, err = composeEnvironment(root, nil); err == nil {
		t.Fatal("public env accepted")
	}
}
func installFixture(t *testing.T) (string, string, *engineFixture) {
	t.Helper()
	folder, err := os.MkdirTemp(".", ".installer-")
	must(t, err)
	root, err := filepath.Abs(folder)
	must(t, err)
	t.Cleanup(func() { os.RemoveAll(root) })
	pub, priv := keys(t)
	der, err := x509.MarshalPKIXPublicKey(pub)
	must(t, err)
	must(t, os.MkdirAll(filepath.Join(root, "keys"), 0700))
	must(t, os.WriteFile(filepath.Join(root, "keys/release-public-key.pem"), pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0600))
	must(t, writeJSON(filepath.Join(root, "youplayer-release.json"), signed(t, sample("v1.0.0", 1), priv)))
	return root, filepath.Join(root, "home"), &engineFixture{refs: sample("v1.0.0", 1).Platforms["linux/amd64"]}
}
func TestInstall(t *testing.T) {
	root, home, f := installFixture(t)
	exe := filepath.Join(root, "bin/youplayer-host-linux-"+runtime.GOARCH)
	must(t, install(root, home, "podman", exe, true, strings.NewReader(""), f.run))
	if _, err := os.Stat(filepath.Join(root, ".env")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("precheck wrote env")
	}
	must(t, install(root, home, "podman", exe, false, strings.NewReader("synthetic\x00synthetic-password"), f.run))
	unit, err := os.ReadFile(filepath.Join(home, ".config/systemd/user/youplayer-updates.service"))
	must(t, err)
	if !strings.Contains(string(unit), " service\n") || strings.Contains(string(unit), "node") {
		t.Fatal(string(unit))
	}
	calls := strings.Join(f.calls, "\n")
	if strings.Index(calls, "pull ") > strings.Index(calls, " up ") || strings.Index(calls, "inspect backend-id frontend-id") > strings.Index(calls, "enable --now") {
		t.Fatal(calls)
	}
	stat, err := os.Stat(filepath.Join(root, ".env"))
	must(t, err)
	if stat.Mode().Perm() != 0600 {
		t.Fatal("env not private")
	}
}
func TestInstallRefusals(t *testing.T) {
	for _, stage := range []string{"info", "pull", " up ", "show-environment"} {
		t.Run(stage, func(t *testing.T) {
			root, home, f := installFixture(t)
			f.fail = stage
			err := install(root, home, "podman", filepath.Join(root, "bin/host"), false, strings.NewReader("synthetic\x00synthetic-password"), f.run)
			if err == nil {
				t.Fatal("failure ignored")
			}
			if strings.Contains(strings.Join(f.calls, "\n"), "enable --now") {
				t.Fatal("enabled failed install")
			}
		})
	}
	root, home, f := installFixture(t)
	must(t, writeJSON(filepath.Join(root, "youplayer-release.json"), envelope{Payload: "bad", Signature: "bad"}))
	if err := install(root, home, "podman", filepath.Join(root, "bin/host"), true, nil, f.run); code(err) != "invalid-signature" || len(f.calls) != 0 {
		t.Fatal(err, f.calls)
	}
}
func TestUnitPaths(t *testing.T) {
	u, err := serviceUnit("/opt/installation space%", "/opt/installation space%/bin/host")
	must(t, err)
	if !strings.Contains(u, "\nWorkingDirectory=/opt/installation space%%\n") || !strings.Contains(u, `ExecStart="/opt/installation space%%/bin/host" service`) {
		t.Fatal(u)
	}
	if _, err = serviceUnit("/opt/new\nline", "/opt/bin/host"); err == nil {
		t.Fatal("newline accepted")
	}
}

func TestInstallExistingStateAndTemporaryPaths(t *testing.T) {
	for _, which := range []string{"state", "service", "volumes", "temporary"} {
		t.Run(which, func(t *testing.T) {
			root, home, f := installFixture(t)
			switch which {
			case "state":
				must(t, writeJSON(filepath.Join(root, ".updates/host/config.json"), map[string]string{"old": "state"}))
			case "service":
				p := filepath.Join(home, ".config/systemd/user/youplayer-updates.service")
				must(t, os.MkdirAll(filepath.Dir(p), 0700))
				must(t, os.WriteFile(p, []byte("existing"), 0600))
			case "volumes":
				f.volumes = project + "_youplayer_data"
			case "temporary":
				original := root
				root = t.TempDir()
				must(t, os.MkdirAll(filepath.Join(root, "keys"), 0700))
				for _, name := range []string{"keys/release-public-key.pem", "youplayer-release.json"} {
					b, err := os.ReadFile(filepath.Join(original, name))
					must(t, err)
					must(t, os.WriteFile(filepath.Join(root, name), b, 0600))
				}
			}
			err := install(root, home, "podman", filepath.Join(root, "bin/host"), false, strings.NewReader("synthetic\x00synthetic-password"), f.run)
			if err == nil {
				t.Fatal("existing or temporary installation accepted")
			}
			if strings.Contains(strings.Join(f.calls, "\n"), "pull ") {
				t.Fatal("download before refusal")
			}
			if which == "temporary" && (!strings.Contains(err.Error(), "permanent") || len(f.calls) != 0) {
				t.Fatal(err, f.calls)
			}
		})
	}
}

func TestCommandMissingAndOutputLimit(t *testing.T) {
	root := t.TempDir()
	must(t, prepareDirectories(root))
	_, err := runCommand(root, "/nonexistent-youplayer-command", nil, os.Environ())
	if code(err) != "command-missing" {
		t.Fatal(err)
	}
	started := time.Now()
	_, err = runCommand(root, "/bin/sh", []string{"-c", "head -c 5000000 /dev/zero"}, os.Environ())
	if code(err) != "command-failed" || time.Since(started) > 10*time.Second {
		t.Fatal("output limit failed", err)
	}
}
