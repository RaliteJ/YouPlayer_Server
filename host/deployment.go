package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const project = "youplayer-server"

type configuration struct {
	Engine   string `json:"engine"`
	Project  string `json:"project"`
	Platform string `json:"platform"`
}
type runner func(string, []string, []string) (string, error)
type deployment struct {
	root   string
	config configuration
	run    runner
	wait   func(time.Duration)
}

func newDeployment(root string, c configuration) (*deployment, error) {
	if (c.Engine != "docker" && c.Engine != "podman") || c.Project != project || (c.Platform != "linux/amd64" && c.Platform != "linux/arm64") {
		return nil, failure("incompatible-release")
	}
	return &deployment{root, c, func(p string, a, e []string) (string, error) { return runCommand(root, p, a, e) }, time.Sleep}, nil
}

// Both output streams share a bound so a child cannot exhaust host memory.
type commandOutput struct {
	mu          sync.Mutex
	out, stderr bytes.Buffer
	length      int
	overflow    bool
	stop        func()
}
type outputWriter struct {
	output *commandOutput
	stderr bool
}

func (w outputWriter) Write(p []byte) (int, error) {
	o := w.output
	o.mu.Lock()
	defer o.mu.Unlock()
	o.length += len(p)
	if o.length > 4*1024*1024 {
		o.overflow = true
		o.stop()
		return len(p), nil
	}
	if w.stderr {
		o.stderr.Write(p)
	} else {
		o.out.Write(p)
	}
	return len(p), nil
}
func runCommand(root, program string, args, env []string) (string, error) {
	timeout := 30 * time.Second
	if program == "podman-compose" || program == "docker" && len(args) > 0 && args[0] == "compose" {
		timeout = 5 * time.Minute
	} else if len(args) > 0 && (args[0] == "pull" || args[0] == "load") {
		timeout = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, program, args...)
	cmd.Dir = root
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = time.Second
	stop := func() {
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
	}
	cmd.Cancel = func() error { stop(); return nil }
	output := &commandOutput{stop: stop}
	cmd.Stdout = outputWriter{output, false}
	cmd.Stderr = outputWriter{output, true}
	err := cmd.Run()
	if err == nil && !output.overflow {
		return output.out.String(), nil
	}
	c := "command-failed"
	if ctx.Err() != nil {
		c = "command-timeout"
	} else if errors.Is(err, os.ErrNotExist) || errors.Is(err, exec.ErrNotFound) {
		c = "command-missing"
	}
	raw := output.stderr.String()
	lower := strings.ToLower(raw)
	if strings.Contains(lower, "address already in use") || strings.Contains(lower, "port is already allocated") {
		c = "port-conflict"
	}
	if strings.Contains(lower, "no space left on device") {
		c = "disk-full"
	}
	if len(raw) > 1024*1024 {
		raw = raw[len(raw)-1024*1024:]
	}
	file := filepath.Join(root, ".updates/host/last-command.log")
	fd, e := syscall.Open(file, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_TRUNC|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if e == nil {
		f := os.NewFile(uintptr(fd), file)
		_ = f.Chmod(0600)
		_, _ = fmt.Fprintf(f, "%s (%s)\n%s", program, c, raw)
		f.Close()
	}
	return "", failure(c)
}
func (d *deployment) engine(args ...string) (string, error) {
	return d.run(d.config.Engine, args, os.Environ())
}
func (d *deployment) compose(args ...string) error {
	env, err := composeEnvironment(d.root, os.Environ())
	if err != nil {
		return err
	}
	p := "podman-compose"
	a := []string{"--in-pod", "false"}
	if d.config.Engine == "docker" {
		p = "docker"
		a = []string{"compose"}
	}
	a = append(a, "--env-file", "/dev/null", "-p", project, "-f", filepath.Join(d.root, "docker-compose.release.yml"), "-f", filepath.Join(d.root, ".updates/host/images.json"))
	_, err = d.run(p, append(a, args...), env)
	return err
}
func (d *deployment) checkTools() error {
	format := "{{.Host.OS}}/{{.Host.Arch}}"
	if d.config.Engine == "docker" {
		format = "{{.OSType}}/{{.Architecture}}"
	}
	value, err := d.engine("info", "--format", format)
	if err != nil {
		return err
	}
	value = strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(value), "/x86_64", "/amd64"), "/aarch64", "/arm64")
	if value != d.config.Platform {
		return failure("platform-mismatch")
	}
	if d.config.Engine == "docker" {
		value, err = d.engine("info", "--format", "{{json .SecurityOptions}}")
		if err != nil {
			return err
		}
		if strings.Contains(value, "rootless") {
			return failure("incompatible-release")
		}
		_, err = d.engine("compose", "version")
		return err
	}
	_, err = d.run("podman-compose", []string{"--version"}, os.Environ())
	return err
}
func (d *deployment) assertFresh() error {
	for _, label := range []string{"com.docker.compose.project", "io.podman.compose.project"} {
		value, err := d.engine("ps", "-a", "-q", "--filter", "label="+label+"="+project)
		if err != nil {
			return err
		}
		if strings.TrimSpace(value) != "" {
			return failure("deployment-changed")
		}
	}
	value, err := d.engine("volume", "ls", "--format", "{{.Name}}")
	if err != nil {
		return err
	}
	for _, name := range strings.Fields(value) {
		if strings.HasPrefix(name, project+"_") {
			return failure("deployment-changed")
		}
	}
	return nil
}

type container struct {
	Config struct {
		Image  string
		Labels map[string]string
	}
	State struct {
		Status      string
		Health      struct{ Status string }
		Healthcheck struct{ Status string }
	}
}

func (d *deployment) inspect() (map[string]container, error) {
	label := "com.docker.compose.project"
	if d.config.Engine == "podman" {
		label = "io.podman.compose.project"
	}
	value, err := d.engine("ps", "-a", "-q", "--filter", "label="+label+"="+project)
	if err != nil {
		return nil, err
	}
	ids := strings.Fields(value)
	if len(ids) < 2 {
		return nil, failure("deployment-changed")
	}
	value, err = d.engine(append([]string{"inspect"}, ids...)...)
	if err != nil {
		return nil, err
	}
	var containers []container
	if json.Unmarshal([]byte(value), &containers) != nil {
		return nil, failure("deployment-changed")
	}
	result := map[string]container{}
	for _, c := range containers {
		labels := c.Config.Labels
		service := labels["com.docker.compose.service"]
		if service == "" {
			service = labels["io.podman.compose.service"]
		}
		if service == "redis" {
			continue
		}
		p := labels["com.docker.compose.project"]
		if p == "" {
			p = labels["io.podman.compose.project"]
		}
		_, exists := result[service]
		if (service != "backend" && service != "frontend") || exists || p != project {
			return nil, failure("deployment-changed")
		}
		result[service] = c
	}
	if len(result) != 2 {
		return nil, failure("deployment-changed")
	}
	return result, nil
}
func (d *deployment) selectImages(refs images) error {
	values := map[string]map[string]any{}
	for _, s := range services {
		values[s] = map[string]any{"image": refs[s], "pull_policy": "never"}
	}
	if d.config.Engine == "podman" {
		values["backend"]["userns_mode"] = "keep-id:uid=1000,gid=1000"
		values["backend"]["volumes"] = []string{"youplayer_data:/var/lib/youplayer:Z,U"}
	} else {
		values["backend"]["user"] = fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid())
	}
	return writeJSON(filepath.Join(d.root, ".updates/host/images.json"), map[string]any{"services": values})
}
func (d *deployment) healthy(refs images) error {
	for attempt := 0; attempt < 90; attempt++ {
		containers, err := d.inspect()
		ok := err == nil
		for _, s := range services {
			c := containers[s]
			health := c.State.Health.Status
			if health == "" {
				health = c.State.Healthcheck.Status
			}
			ok = ok && c.Config.Image == refs[s] && c.State.Status == "running" && health == "healthy"
		}
		if ok {
			return nil
		}
		d.wait(2 * time.Second)
	}
	return failure("health-failed")
}
func (d *deployment) assertCurrent(refs images) error {
	cs, err := d.inspect()
	if err != nil {
		return err
	}
	for _, s := range services {
		if cs[s].Config.Image != refs[s] {
			return failure("deployment-changed")
		}
	}
	return d.healthy(refs)
}
func (d *deployment) resume(refs images) error {
	cs, err := d.inspect()
	if err != nil {
		return err
	}
	stopped := false
	for _, s := range services {
		if cs[s].Config.Image != refs[s] {
			return failure("deployment-changed")
		}
		stopped = stopped || cs[s].State.Status != "running"
	}
	if stopped {
		if err = d.activate(refs, true); err != nil {
			return err
		}
	}
	return d.healthy(refs)
}
func (d *deployment) pull(refs images) error {
	for _, s := range services {
		if _, err := d.engine("pull", refs[s]); err != nil {
			return err
		}
		v, err := d.engine("image", "inspect", refs[s])
		if err != nil {
			return err
		}
		var values []struct{ Os, Architecture string }
		if json.Unmarshal([]byte(v), &values) != nil || len(values) != 1 || values[0].Os+"/"+values[0].Architecture != d.config.Platform {
			return failure("platform-mismatch")
		}
	}
	return nil
}
func (d *deployment) initializeData(refs images) error {
	if d.config.Engine != "docker" {
		return nil
	}
	if _, err := d.engine("volume", "create", project+"_youplayer_data"); err != nil {
		return err
	}
	_, err := d.engine("run", "--rm", "--network", "none", "--user", "0:0", "--entrypoint", "chown", "-v", project+"_youplayer_data:/data", refs["backend"], fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid()), "/data")
	return err
}
func (d *deployment) activate(refs images, first bool) error {
	if err := d.selectImages(refs); err != nil {
		return err
	}
	a := []string{"up", "-d", "--no-build"}
	if !first {
		a = append(a, "--no-deps")
	}
	return d.compose(append(a, services...)...)
}
