package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

func readJSON(file string, limit int64, value any) error {
	fd, err := syscall.Open(file, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), file)
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return err
	}
	if !stat.Mode().IsRegular() || stat.Size() > limit {
		return failure("invalid-request")
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > limit {
		return failure("invalid-request")
	}
	return json.Unmarshal(data, value)
}
func syncDirectory(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
func writeJSON(file string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	dir := filepath.Dir(file)
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".release-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(f.Name(), file); err != nil {
		return err
	}
	return syncDirectory(dir)
}
func removeDurable(file string) error {
	if err := os.Remove(file); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(file))
}
func privateWrite(file string, data []byte) error {
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err = f.Write(data); err != nil {
		return err
	}
	return f.Sync()
}
func prepareDirectories(root string) error {
	for _, dir := range []string{".updates/host", ".updates/requests", ".updates/status", "src/playlists", "src/local_song"} {
		p := filepath.Join(root, dir)
		if err := os.MkdirAll(p, 0700); err != nil {
			return err
		}
		if err := os.Chmod(p, 0700); err != nil {
			return err
		}
	}
	return nil
}
func randomSecret() (string, error) {
	b := make([]byte, 48)
	_, err := rand.Read(b)
	return hex.EncodeToString(b), err
}
func prepareEnvironment(root, pseudo, password string) error {
	file := filepath.Join(root, ".env")
	stat, err := os.Lstat(file)
	if err == nil {
		if !stat.Mode().IsRegular() {
			return failure("environment-invalid")
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if !regexp.MustCompile(`^[a-zA-Z0-9_.@-]{1,100}$`).MatchString(pseudo) || len([]rune(password)) < 12 || strings.ContainsAny(password, "'\\\r\n\x00") {
		return errors.New("Pseudo invalide ou mot de passe trop court / contenant une apostrophe ou un antislash.")
	}
	session, err := randomSecret()
	if err != nil {
		return err
	}
	spotify, err := randomSecret()
	if err != nil {
		return err
	}
	values := [][2]string{{"COMPOSE_PROJECT_NAME", project}, {"YOUPLAYER_ADMIN_PSEUDO", pseudo}, {"YOUPLAYER_ADMIN_PASSWORD", password}, {"YOUPLAYER_SESSION_SECRET", session}, {"YOUPLAYER_SPOTIFY_TOKEN_SECRET", spotify}, {"YOUPLAYER_LOG_LEVEL", "info"}, {"YOUPLAYER_SESSION_MAX_AGE_MS", "259200000"}, {"FIRST_TRACK_SPECIAL_STREAM", "true"}, {"FIRST_TRACK_SPECIAL_STREAM_NEXT", "true"}}
	for _, name := range []string{"YOUPLAYER_YOUTUBE_API_KEY", "YOUPLAYER_SPOTIFY_CLIENT_ID", "YOUPLAYER_SPOTIFY_CLIENT_SECRET", "YOUPLAYER_SPOTIFY_REDIRECT_URI", "YOUPLAYER_SPOTIFY_SCOPES", "YOUPLAYER_SPOTIFY_WEB_USERNAME", "YOUPLAYER_SPOTIFY_WEB_PASSWORD"} {
		values = append(values, [2]string{name, ""})
	}
	var b strings.Builder
	for _, pair := range values {
		fmt.Fprintf(&b, "%s='%s'\n", pair[0], pair[1])
	}
	return privateWrite(file, []byte(b.String()))
}
func composeEnvironment(root string, inherited []string) ([]string, error) {
	file := filepath.Join(root, ".env")
	stat, err := os.Lstat(file)
	if err != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 {
		return nil, failure("environment-invalid")
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	local := map[string]string{}
	pattern := regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_]*)=(.*)$`)
	for _, line := range strings.Split(string(data), "\n") {
		match := pattern.FindStringSubmatch(strings.TrimSpace(line))
		if match == nil {
			continue
		}
		if _, ok := local[match[1]]; ok {
			continue
		}
		v := strings.TrimSpace(match[2])
		if len(v) >= 2 && ((v[0] == '\'' && v[len(v)-1] == '\'') || (v[0] == '"' && v[len(v)-1] == '"')) {
			v = v[1 : len(v)-1]
		}
		local[match[1]] = v
	}
	if p := local["COMPOSE_PROJECT_NAME"]; p != "" && p != project {
		return nil, failure("project-mismatch")
	}
	weak := func(s string) bool {
		return len(s) < 32 || regexp.MustCompile(`(?i)replace|change|example|local-session|dev-session|^\$\{`).MatchString(s)
	}
	if weak(local["YOUPLAYER_SESSION_SECRET"]) {
		return nil, failure("environment-invalid")
	}
	if local["YOUPLAYER_SPOTIFY_CLIENT_ID"] != "" && local["YOUPLAYER_SPOTIFY_CLIENT_SECRET"] != "" && local["YOUPLAYER_SPOTIFY_REDIRECT_URI"] != "" && weak(local["YOUPLAYER_SPOTIFY_TOKEN_SECRET"]) {
		return nil, failure("environment-invalid")
	}
	env := []string{}
	for _, v := range inherited {
		k, _, _ := strings.Cut(v, "=")
		if !strings.HasPrefix(k, "YOUPLAYER_") && !strings.HasPrefix(k, "COMPOSE_") && k != "SESSION_SECRET" && k != "DATABASE_URL" && k != "REDIS_URL" {
			env = append(env, v)
		}
	}
	for k, v := range local {
		if strings.HasPrefix(k, "YOUPLAYER_") {
			env = append(env, k+"="+v)
		}
	}
	return append(env, "COMPOSE_PROJECT_NAME="+project), nil
}
