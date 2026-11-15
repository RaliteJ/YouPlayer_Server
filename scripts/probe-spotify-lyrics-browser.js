// Run in the Spotify Bridge extension's background console, not a website console.
(async () => {
    const api = globalThis.browser ?? globalThis.chrome;
    const report = result => console.log(JSON.stringify({ test: 'spotify-user-lyrics', ...result }));
    if (!api?.storage?.session || !api.permissions) {
        report({ error: 'Ouvrir la console de fond de l’extension Spotify Bridge.' });
        return;
    }
    try {
        const key = 'spotifyWebPlayerSession';
        const session = (await api.storage.session.get(key))[key];
        if (!session?.token || session.isAnonymous === true || !(session.expiresAt > Date.now())) {
            report({ error: 'Ouvrir Spotify connecté, lancer un titre, puis relancer ce test.' });
            return;
        }
        const permission = { origins: ['https://spclient.wg.spotify.com/*'] };
        if (!await api.permissions.contains(permission) && !await api.permissions.request(permission)) {
            report({ error: 'Permission pour le serveur de paroles Spotify refusée.' });
            return;
        }
        const trackId = '5f8eCNwTlr0RJopE9vQ6mB';
        const response = await fetch(`https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&market=from_token`, {
            headers: { Authorization: `Bearer ${session.token}`, 'App-Platform': 'WebPlayer', Accept: 'application/json' },
            redirect: 'error', signal: AbortSignal.timeout(12000)
        });
        if (!response.ok) {
            await response.body?.cancel();
            report({ status: response.status });
            return;
        }
        const data = await response.json();
        const current = (await api.storage.session.get(key))[key];
        if (current?.token !== session.token) {
            report({ error: 'La session a changé pendant le test. Réessayer.' });
            return;
        }
        report({ status: response.status, syncType: data.lyrics?.syncType ?? null,
            lineCount: Array.isArray(data.lyrics?.lines) ? data.lyrics.lines.length : 0 });
    } catch {
        report({ error: 'Test interrompu : réseau, permission ou réponse invalide. Aucun jeton affiché.' });
    }
})();
