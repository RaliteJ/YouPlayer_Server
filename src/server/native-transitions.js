/** Serialize native session mutations, including a retry whose first response was lost.
 * Single backend process, matching the private Compose deployment.
 */
export function nativeSessionQueue() {
    const locks = new Map();
    return async (req, res, next) => {
        if (req.get('X-YouPlayer-Native') !== '1' || !req.sessionID
            || req.path.startsWith('/audio/') || req.path.startsWith('/play/')) return next();
        const key = req.sessionID;
        const prior = locks.get(key) || Promise.resolve();
        let release;
        const held = new Promise(resolve => { release = resolve; });
        locks.set(key, held);
        await prior;
        const unlock = () => {
            release();
            if (locks.get(key) === held) locks.delete(key);
        };
        // Never unlock on a disconnected socket: the handler may still be mutating its session.
        // All native route handlers explicitly save before ending their response.
        const end = res.end;
        res.end = function (...args) {
            const result = end.apply(this, args);
            unlock();
            return result;
        };
        if (req.session?.userId || req.session?.playlists) {
            req.session.reload(error => {
                if (error) return res.status(401).json({ error: 'Session expirée' });
                next();
            });
        } else next();
    };
}

export function readNativeTransition(req) {
    if (req.get('X-YouPlayer-Native') !== '1') return null;
    const id = req.get('X-YouPlayer-Transition') || '';
    const previous = req.get('X-YouPlayer-Previous');
    const reason = req.get('X-YouPlayer-Reason');
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(id) || !/^(null|[0-9]+)$/.test(previous || '')
        || !['manual', 'ended'].includes(reason)) {
        const error = new Error('Transition native invalide'); error.statusCode = 400; throw error;
    }
    const receipt = (req.session.native_transition_receipts || []).find(item => item.id === id);
    if (receipt && (receipt.previous !== previous || receipt.reason !== reason)) {
        const error = new Error('Identifiant de transition réutilisé'); error.statusCode = 409; throw error;
    }
    return { id, previous, reason, receipt };
}

export function saveNextResponse(req, res, data, transition) {
    if (transition) {
        data = { ...data, nativePlaybackVersion: 1 };
        req.session.native_transition_receipts = [
            ...(req.session.native_transition_receipts || []).filter(item => item.id !== transition.id),
            { id: transition.id, previous: transition.previous, reason: transition.reason, data }
        ].slice(-20);
    }
    req.session.save(error => {
        if (error) return res.status(503).json({ error: 'Sauvegarde de transition impossible' });
        res.json(data);
    });
}
