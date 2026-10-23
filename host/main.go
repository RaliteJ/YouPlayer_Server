package main

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

func loadKey(root string) (ed25519.PublicKey, error) {
	data, err := os.ReadFile(filepath.Join(root, "keys/release-public-key.pem"))
	if err != nil {
		return nil, err
	}
	return publicKey(data)
}
func serviceUnit(root, executable string) (string, error) {
	if !filepath.IsAbs(root) || !filepath.IsAbs(executable) || strings.ContainsAny(root+executable, "\r\n\x00$") {
		return "", failure("incompatible-release")
	}
	// systemd parses WorkingDirectory as a path, ExecStart as command arguments.
	quote := func(v string) string {
		return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, `%`, `%%`).Replace(v) + `"`
	}
	return "[Unit]\nDescription=YouPlayer release updates\nAfter=default.target\n\n[Service]\nType=simple\nWorkingDirectory=" + strings.ReplaceAll(root, "%", "%%") + "\nExecStart=" + quote(executable) + " service\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=900\nKillMode=mixed\nUMask=0077\n\n[Install]\nWantedBy=default.target\n", nil
}
func exists(file string) (bool, error) {
	_, err := os.Lstat(file)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}
func install(root, home, engine, executable string, check bool, input io.Reader, command runner) error {
	key, err := loadKey(root)
	if err != nil {
		return fmt.Errorf("Archive incomplète : utiliser youplayer-install.tar.gz, pas un clone Git : %w", err)
	}
	var e envelope
	if err = readJSON(filepath.Join(root, "youplayer-release.json"), 64*1024, &e); err != nil {
		return errors.New("Archive incomplète : utiliser youplayer-install.tar.gz, pas un clone Git.")
	}
	m, err := verifyManifest(e, key)
	if err != nil {
		return err
	}
	c := configuration{engine, project, "linux/" + runtime.GOARCH}
	d, err := newDeployment(root, c)
	if err != nil {
		return err
	}
	if command != nil {
		d.run = command
	}
	// An installed service records this absolute path and must survive reboot cleanup.
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	for _, temporary := range []string{"/tmp", "/var/tmp", "/run"} {
		if resolved == temporary || strings.HasPrefix(resolved, temporary+"/") {
			return errors.New("Extraire l'archive dans un dossier permanent (par exemple ~/youplayer), hors de /tmp, /var/tmp et /run.")
		}
	}
	if err = d.checkTools(); err != nil {
		return err
	}
	if err = d.assertFresh(); err != nil {
		if code(err) != "deployment-changed" {
			return err
		}
		return errors.New("Installation refusée : des conteneurs ou volumes YouPlayer existent déjà. Conserver les données et examiner l'installation existante.")
	}
	run := func(p string, a ...string) (string, error) { return d.run(p, a, os.Environ()) }
	if _, err = run("systemctl", "--user", "show-environment"); err != nil {
		return err
	}
	linger, err := run("loginctl", "show-user", fmt.Sprint(os.Getuid()), "--property=Linger", "--value")
	if err != nil {
		return err
	}
	if strings.TrimSpace(linger) != "yes" {
		return errors.New("Activer la persistance : sudo loginctl enable-linger \"$USER\".")
	}
	unitFile := filepath.Join(home, ".config/systemd/user/youplayer-updates.service")
	for _, file := range []string{filepath.Join(root, ".updates/host/config.json"), unitFile} {
		present, err := exists(file)
		if err != nil {
			return err
		}
		if present {
			return fmt.Errorf("Installation refusée : %s existe déjà. Ne pas effacer les données pour relancer.", file)
		}
	}
	unit, err := serviceUnit(root, executable)
	if err != nil {
		return err
	}
	if check {
		return nil
	}
	hasEnv, err := exists(filepath.Join(root, ".env"))
	if err != nil {
		return err
	}
	pseudo, password := "", ""
	if !hasEnv {
		data, err := io.ReadAll(io.LimitReader(input, 4097))
		if err != nil {
			return err
		}
		if len(data) > 4096 {
			return errors.New("Identifiants trop longs.")
		}
		parts := strings.Split(string(data), "\x00")
		if len(parts) != 2 {
			return errors.New("Lancer ./install.sh dans un terminal interactif.")
		}
		pseudo, password = parts[0], parts[1]
	}
	if err = prepareEnvironment(root, pseudo, password); err != nil {
		return err
	}
	if _, err = composeEnvironment(root, os.Environ()); err != nil {
		return err
	}
	if err = prepareDirectories(root); err != nil {
		return err
	}
	refs := m.Platforms[c.Platform]
	fmt.Printf("Téléchargement de YouPlayer %s…\n", m.Version)
	if err = d.pull(refs); err != nil {
		return err
	}
	if err = d.initializeData(refs); err != nil {
		return err
	}
	if err = writeJSON(filepath.Join(root, ".updates/host/config.json"), c); err != nil {
		return err
	}
	if err = writeJSON(filepath.Join(root, ".updates/host/release-state.json"), installedState{Envelope: e}); err != nil {
		return err
	}
	fmt.Println("Démarrage des services…")
	if err = d.activate(refs, true); err != nil {
		return err
	}
	if err = d.healthy(refs); err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(unitFile), 0700); err != nil {
		return err
	}
	if err = privateWrite(unitFile, []byte(unit)); err != nil {
		return err
	}
	if _, err = run("systemctl", "--user", "daemon-reload"); err != nil {
		return err
	}
	if _, err = run("systemctl", "--user", "enable", "--now", "youplayer-updates.service"); err != nil {
		return err
	}
	fmt.Println("YouPlayer est prêt : https://ADRESSE_DU_SERVEUR:8443\nConnectez-vous avec le compte admin, puis créez un compte user pour écouter.")
	return nil
}
func lockService(root string) (*os.File, error) {
	file := filepath.Join(root, ".updates/host/service.lock")
	fd, err := syscall.Open(file, syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), file)
	if err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("Un service de mise à jour est déjà actif.")
	}
	return f, nil
}
func serve(root string) error {
	lock, err := lockService(root)
	if err != nil {
		return err
	}
	defer lock.Close()
	var c configuration
	if err = readJSON(filepath.Join(root, ".updates/host/config.json"), 4096, &c); err != nil {
		return err
	}
	key, err := loadKey(root)
	if err != nil {
		return err
	}
	d, err := newDeployment(root, c)
	if err != nil {
		return err
	}
	if err = d.checkTools(); err != nil {
		return err
	}
	w := &worker{root: root, config: c, key: key, deployment: d, latest: func() (envelope, error) { return latest(http.DefaultClient, key) }, now: time.Now}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)
	if err = w.initialize(); err != nil {
		return err
	}
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		timer := time.NewTicker(5 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-done:
				return
			case <-timer.C:
				_ = w.publish()
			}
		}
	}()
	defer func() {
		close(done)
		<-finished
		w.mu.Lock()
		defer w.mu.Unlock()
		w.state.Heartbeat = 0
		_ = writeJSON(filepath.Join(root, ".updates/status/release.json"), w.state)
	}()
	timer := time.NewTicker(time.Second)
	defer timer.Stop()
	for {
		select {
		case <-signals:
			return nil
		case <-timer.C:
			if err = w.tick(); err != nil {
				return err
			}
		}
	}
}
func main() {
	syscall.Umask(0077)
	err := func() error {
		if len(os.Args) == 2 && os.Args[1] == "version" {
			fmt.Println("YouPlayer host contract 1 (sans Node.js)")
			return nil
		}
		if runtime.GOOS != "linux" || os.Getuid() == 0 {
			return errors.New("Utiliser Linux et un compte utilisateur, sans sudo.")
		}
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		executable, err = filepath.EvalSymlinks(executable)
		if err != nil {
			return err
		}
		root := filepath.Dir(filepath.Dir(executable))
		if len(os.Args) == 2 && os.Args[1] == "service" {
			return serve(root)
		}
		if len(os.Args) < 2 || len(os.Args) > 3 || (os.Args[1] != "check" && os.Args[1] != "install") {
			return errors.New("Lancer ./install.sh [podman|docker] depuis une archive de release.")
		}
		engine := "podman"
		if len(os.Args) == 3 {
			engine = os.Args[2]
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		return install(root, home, engine, executable, os.Args[1] == "check", os.Stdin, nil)
	}()
	if err != nil {
		if _, ok := err.(failure); ok {
			fmt.Fprintf(os.Stderr, "Opération arrêtée (%s). Voir INSTALL.md et, si présent, le diagnostic privé .updates/host/last-command.log.\n", code(err))
		} else {
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
