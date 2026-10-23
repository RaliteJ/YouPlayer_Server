package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type failure string

func (e failure) Error() string { return string(e) }
func code(err error) string {
	var e failure
	if errors.As(err, &e) {
		return string(e)
	}
	return "internal"
}

var versionPattern = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var commitPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)
var services = []string{"backend", "frontend"}

type images map[string]string
type envelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}
type manifest struct {
	Schema             int               `json:"schema"`
	Contract           int               `json:"contract"`
	DataVersion        int               `json:"dataVersion"`
	RollbackCompatible bool              `json:"rollbackCompatible"`
	Version            string            `json:"version"`
	Commit             string            `json:"commit"`
	Sequence           int64             `json:"sequence"`
	Platforms          map[string]images `json:"platforms"`
}

func verifyManifest(e envelope, key ed25519.PublicKey) (manifest, error) {
	var m manifest
	if len(e.Payload) > 32000 || len(e.Signature) > 100 {
		return m, failure("invalid-signature")
	}
	data, err := base64.StdEncoding.DecodeString(e.Payload)
	if err != nil {
		return m, failure("invalid-signature")
	}
	sig, err := base64.StdEncoding.DecodeString(e.Signature)
	if err != nil || len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, data, sig) {
		return m, failure("invalid-signature")
	}
	if json.Unmarshal(data, &m) != nil {
		return m, failure("invalid-release")
	}
	if m.Schema != 3 || m.Contract != 1 || m.DataVersion != 1 || !m.RollbackCompatible || !versionPattern.MatchString(m.Version) || !commitPattern.MatchString(m.Commit) || m.Sequence < 1 || m.Sequence > 9007199254740991 || len(m.Platforms) != 2 {
		return m, failure("incompatible-release")
	}
	for _, platform := range []string{"linux/amd64", "linux/arm64"} {
		refs := m.Platforms[platform]
		if len(refs) != 2 {
			return m, failure("invalid-release")
		}
		for _, service := range services {
			prefix := "ghcr.io/ralitej/youplayer-server-" + service + "@sha256:"
			if !strings.HasPrefix(refs[service], prefix) || !digestPattern.MatchString(strings.TrimPrefix(refs[service], prefix)) {
				return m, failure("invalid-release")
			}
		}
	}
	return m, nil
}
func publicKey(data []byte) (ed25519.PublicKey, error) {
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, failure("invalid-signature")
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, failure("invalid-signature")
	}
	result, ok := key.(ed25519.PublicKey)
	if !ok {
		return nil, failure("invalid-signature")
	}
	return result, nil
}
func compareVersions(a, b string) int {
	aa, bb := strings.Split(a[1:], "."), strings.Split(b[1:], ".")
	for i := 0; i < 3; i++ {
		x, _ := new(big.Int).SetString(aa[i], 10)
		y, _ := new(big.Int).SetString(bb[i], 10)
		if c := x.Cmp(y); c != 0 {
			return c
		}
	}
	return 0
}
func identity(e envelope) string {
	sum := sha256.Sum256([]byte(e.Payload))
	return hex.EncodeToString(sum[:])
}
func allowedURL(u *url.URL) bool {
	if u.Scheme != "https" || u.User != nil {
		return false
	}
	switch u.Host {
	case "api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
		return true
	}
	return false
}
func fetchJSON(client *http.Client, address string, asset bool, result any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	// Redirects are checked before every request, including the initial URL.
	c := *client
	c.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	for redirects := 0; redirects <= 4; redirects++ {
		u, err := url.Parse(address)
		if err != nil || !allowedURL(u) {
			return failure("download-origin")
		}
		req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
		if err != nil {
			return failure("download-origin")
		}
		req.Header.Set("User-Agent", "YouPlayer-Updater")
		req.Header.Set("Accept", "application/vnd.github+json")
		if asset {
			req.Header.Set("Accept", "application/octet-stream")
		}
		res, err := c.Do(req)
		if err != nil {
			return failure("release-unavailable")
		}
		if res.StatusCode == 301 || res.StatusCode == 302 || res.StatusCode == 303 || res.StatusCode == 307 || res.StatusCode == 308 {
			location := res.Header.Get("Location")
			res.Body.Close()
			next, err := url.Parse(location)
			if err != nil || location == "" {
				return failure("release-unavailable")
			}
			address = u.ResolveReference(next).String()
			continue
		}
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			res.Body.Close()
			if res.StatusCode == 404 {
				return failure("no-release")
			}
			return failure("release-unavailable")
		}
		data, err := io.ReadAll(io.LimitReader(res.Body, 1024*1024+1))
		res.Body.Close()
		if err != nil || len(data) > 1024*1024 || json.Unmarshal(data, result) != nil {
			return failure("invalid-release")
		}
		return nil
	}
	return failure("download-origin")
}
func latest(client *http.Client, key ed25519.PublicKey) (envelope, error) {
	var release struct {
		Draft      *bool  `json:"draft"`
		Prerelease *bool  `json:"prerelease"`
		Tag        string `json:"tag_name"`
		Assets     []struct {
			Name string `json:"name"`
			URL  string `json:"url"`
		} `json:"assets"`
	}
	var e envelope
	if err := fetchJSON(client, "https://api.github.com/repos/RaliteJ/YouPlayer_Server/releases/latest", false, &release); err != nil {
		return e, err
	}
	if release.Draft == nil || *release.Draft || release.Prerelease == nil || *release.Prerelease || !versionPattern.MatchString(release.Tag) {
		return e, failure("invalid-release")
	}
	address := ""
	count := 0
	for _, asset := range release.Assets {
		if asset.Name == "youplayer-release.json" {
			address = asset.URL
			count++
		}
	}
	if count != 1 || !regexp.MustCompile(`^https://api\.github\.com/repos/RaliteJ/YouPlayer_Server/releases/assets/[0-9]+$`).MatchString(address) {
		return e, failure("invalid-release")
	}
	if err := fetchJSON(client, address, true, &e); err != nil {
		return e, err
	}
	m, err := verifyManifest(e, key)
	if err != nil {
		return e, err
	}
	if m.Version != release.Tag {
		return e, failure("invalid-release")
	}
	return e, nil
}
