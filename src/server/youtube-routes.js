import { logger } from './logger.js';
import { RequestValidationError, requireYoutubeApiKey } from './validation.js';

const YOUTUBE_SEARCH_FILTERS = new Set(["all", "video", "playlist", "channel"]);

export function registerYoutubeRoutes(app, {
	requireAuth, sendJsonError, youtubeApiKey: API_KEY,
	fetchImpl = (...args) => fetch(...args)
}) {
	app.post("/send_search_youtube", requireAuth, async (req, res) => {
		try {
			const apiKey = requireYoutubeApiKey(API_KEY);
			const query = String(req.body?.arg || "").trim();
			if (!query) {
				return res.status(400).json({ error: "Recherche YouTube vide" });
			}
			// Optional strict filter, validated before any network call: absent
			// keeps the exact legacy behaviour of two video+playlist searches.
			const filter = req.body?.type;
			if (filter !== undefined && !YOUTUBE_SEARCH_FILTERS.has(filter)) {
				return res.status(400).json({ error: "Type de recherche YouTube invalide" });
			}

			logger.debug("Recherche Youtube:", query);
			const baseUrl = "https://www.googleapis.com/youtube/v3/search";
			const searchUrl = (type, maxResults) => {
				const url = new URL(baseUrl);
				url.searchParams.set("part", "snippet");
				url.searchParams.set("type", type);
				url.searchParams.set("maxResults", String(maxResults));
				url.searchParams.set("q", query);
				url.searchParams.set("key", apiKey);
				return url;
			};

			if (filter !== undefined) {
				// An explicit "all" performs a single combined request within
				// the same quota unit; targeted filters stay one call each.
				const targeted = filter === "all"
					? { type: "video,playlist,channel", maxResults: 24 }
					: { type: filter, maxResults: 8 };
				const response = await fetchImpl(searchUrl(targeted.type, targeted.maxResults));
				if (!response.ok) {
					throw new RequestValidationError("Recherche YouTube impossible", 502);
				}
				const data = await response.json();
				return res.status(200).send({ ...data, items: data.items || [] });
			}

			const videoUrl = searchUrl("video", 8);
			const playlistUrl = searchUrl("playlist", 8);

			const [videoResponse, playlistResponse] = await Promise.all([
				fetchImpl(videoUrl),
				fetchImpl(playlistUrl)
			]);
			if (!videoResponse.ok || !playlistResponse.ok) {
				throw new RequestValidationError("Recherche YouTube impossible", 502);
			}
			const [videoData, playlistData] = await Promise.all([
				videoResponse.json(),
				playlistResponse.json()
			]);
			let data = {
				...videoData,
				items: [
					...(playlistData.items || []),
					...(videoData.items || [])
				]
			};

			res.status(200).send(data);
		} catch (err) {
			sendJsonError(res, err, "Recherche YouTube impossible", 500);
		}
	});

}
