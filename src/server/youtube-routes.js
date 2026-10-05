import { logger } from './logger.js';
import { RequestValidationError, requireYoutubeApiKey } from './validation.js';

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

			logger.debug("Recherche Youtube:", query);
			const baseUrl = "https://www.googleapis.com/youtube/v3/search";
			const videoUrl = new URL(baseUrl);
			videoUrl.searchParams.set("part", "snippet");
			videoUrl.searchParams.set("type", "video");
			videoUrl.searchParams.set("maxResults", "8");
			videoUrl.searchParams.set("q", query);
			videoUrl.searchParams.set("key", apiKey);

			const playlistUrl = new URL(baseUrl);
			playlistUrl.searchParams.set("part", "snippet");
			playlistUrl.searchParams.set("type", "playlist");
			playlistUrl.searchParams.set("maxResults", "8");
			playlistUrl.searchParams.set("q", query);
			playlistUrl.searchParams.set("key", apiKey);

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
