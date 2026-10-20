import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const ARTICLE_TITLE = "The Quiet Return of the Night Train";
export const ARTICLE_HIGHLIGHT =
	"Sleeper services now carry more passengers between Vienna and Hamburg than the morning flights they were expected to lose to.";
export const ARTICLE_SECOND_HIGHLIGHT =
	"Rolling stock remains the bottleneck: a new sleeper car takes four years from order to first service.";
export const ARTICLE_ENDING =
	"The night train is not coming back as nostalgia. It is coming back because, for a growing number of trips, it is simply the better way to go.";
export const SHORT_TITLE = "Station opening hours";
export const SHORT_TEXT =
	"The ticket office at Central Station opens at 6:00 and closes at 22:30 every day, including public holidays.";
export const NEXT_TITLE = "Timetable changes for December";

const SECTIONS: { heading: string; lead: string; facts: string[] }[] = [
	{
		heading: "A service written off too early",
		lead: "For most of the 2000s, European rail operators treated overnight trains as a museum piece.",
		facts: [
			"Timetables were thinned out every December, and each cut was explained as a response to falling demand.",
			"Rolling stock was sold to operators in the east or simply parked in sidings, where it slowly lost its value.",
			"Budget airlines offered fares that no sleeper could match, and travellers followed the price.",
			"Ministries saw the trains as a subsidy line to trim rather than as part of a transport network.",
		],
	},
	{
		heading: "Who rides the night train now",
		lead: "The passengers who came back are not the ones the operators expected.",
		facts: [
			ARTICLE_HIGHLIGHT,
			"Families travelling with young children book the six-berth couchettes months ahead of the summer holidays.",
			"Business travellers use the private compartments to arrive at a morning meeting without an early alarm.",
			"Students choose the seated cars, which cost about as much as a long-distance coach ticket.",
		],
	},
	{
		heading: "The economics of sleeping on rails",
		lead: "A night train earns money in a different way from a day train.",
		facts: [
			"Each bed is sold once per night, so a sleeper car carries far fewer paying passengers than a seated car of the same length.",
			"Operators make up the difference with higher fares, breakfast service and premium compartments with their own shower.",
			"Track access charges at night are often lower, but some countries still price them as if the line were busy.",
			"Staffing is the largest cost, because every car needs an attendant for the whole journey.",
		],
	},
	{
		heading: "Building the network again",
		lead: "Restoring routes has turned out to be slower than announcing them.",
		facts: [
			ARTICLE_SECOND_HIGHLIGHT,
			"Several operators share cars across borders, which means one late connection can disrupt three countries at once.",
			"Maintenance depots that once serviced sleepers have been closed or converted, so cars travel hundreds of kilometres empty for repairs.",
			"Signalling upgrades sometimes close lines overnight, exactly when the trains need them.",
		],
	},
	{
		heading: "What travellers say",
		lead: "Surveys of passengers point to the same few reasons for choosing the train.",
		facts: [
			"Most respondents name the city-centre arrival as the main advantage over flying.",
			"Many say they value a full working day at the destination more than the speed of the journey.",
			"A smaller group cites lower emissions, although few say it is the only reason they booked.",
			"Complaints focus on noisy couplings at border stations and on booking systems that cannot sell a through ticket.",
		],
	},
	{
		heading: "Policy and the next decade",
		lead: "Governments have started to treat overnight rail as infrastructure again.",
		facts: [
			"Some ministries now fund new routes for an initial period of five years before reviewing them.",
			"Proposals for a European booking platform would let passengers buy a single ticket across operators.",
			"Lower track charges for night services are being discussed in at least four countries.",
			"Airports near popular sleeper destinations have begun to cut short-haul slots on the same routes.",
		],
	},
];

const DETAILS = [
	"Operators publish load figures only once a year, so the picture is always a little out of date.",
	"On the busiest routes the summer trains sell out within days of booking opening.",
	"Winter demand is lower but steadier, driven by skiing holidays and the Christmas period.",
	"Ticket prices vary widely depending on how early travellers book and which compartment they choose.",
	"Rail unions have pushed for better rest facilities for staff who work the overnight shifts.",
	"Local councils along the routes have lobbied for extra stops, which would lengthen the journey.",
];

function paragraphs(): string[] {
	const out: string[] = [];
	for (const [index, section] of SECTIONS.entries()) {
		out.push(`<h2>${section.heading}</h2>`);
		out.push(`<p>${section.lead} ${section.facts[0]}</p>`);
		for (let round = 0; round < 6; round++) {
			const fact = section.facts[(round % 3) + 1] ?? "";
			const detail = DETAILS[(index + round) % DETAILS.length] ?? "";
			out.push(
				`<p>${fact} ${detail} Observers in ${["Vienna", "Hamburg", "Zurich", "Brussels", "Prague", "Milan"][round] ?? "Berlin"} noted the same pattern in ${2018 + round}, when ${120 + index * 17 + round * 9} additional berths were offered on the corridor.</p>`,
			);
		}
	}
	out.push(`<h2>Conclusion</h2>`);
	out.push(`<p>${ARTICLE_ENDING}</p>`);
	return out;
}

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
body { font: 17px/1.6 Georgia, serif; color: #1f2933; background: #fbfaf7; margin: 0; }
header.site { background: #12355b; color: white; padding: 14px 32px; font: 600 15px system-ui, sans-serif; }
article { max-width: 680px; margin: 32px auto; padding: 0 24px; }
h1 { font-size: 34px; line-height: 1.2; margin-bottom: 4px; }
.byline { color: #66788a; font: 14px system-ui, sans-serif; margin-bottom: 28px; }
h2 { font-size: 22px; margin-top: 36px; }
footer { color: #66788a; font: 13px system-ui, sans-serif; text-align: center; padding: 40px; }
</style>
</head>
<body>
<header class="site">The Rail Review</header>
<article>
${body}
</article>
<footer>The Rail Review · Independent reporting on European railways</footer>
</body>
</html>`;
}

function articleHtml(): string {
	return page(
		ARTICLE_TITLE,
		`<h1>${ARTICLE_TITLE}</h1>
<p class="byline">By Lena Hartmann · 14 min read · <a href="/next">Timetable changes</a></p>
${paragraphs().join("\n")}`,
	);
}

function shortHtml(): string {
	return page(
		SHORT_TITLE,
		`<h1>${SHORT_TITLE}</h1>\n<p>${SHORT_TEXT}</p>\n<p>Luggage lockers are available on platform 1 from 5:30.</p>`,
	);
}

function nextHtml(): string {
	return page(
		NEXT_TITLE,
		`<h1>${NEXT_TITLE}</h1>
<p>From 14 December the Vienna to Hamburg sleeper departs at 20:12 instead of 19:58, and arrives in Hamburg at 9:05.</p>
<p>The Zurich to Prague service will run four nights a week through the winter and daily again from March.</p>
<p>Reservations for the new timetable open six weeks before travel.</p>`,
	);
}

export interface Site {
	origin: string;
	url(path: "/article" | "/short" | "/next"): string;
	close(): Promise<void>;
}

export async function startSite(host: string): Promise<Site> {
	const routes: Record<string, () => string> = {
		"/article": articleHtml,
		"/short": shortHtml,
		"/next": nextHtml,
	};
	const server: Server = createServer((request, response) => {
		const render = routes[new URL(request.url ?? "/", "http://x").pathname];
		if (render === undefined) {
			response.writeHead(404, { "content-type": "text/plain" });
			response.end("not found");
			return;
		}
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(render());
	});
	server.listen(0, host);
	await once(server, "listening");
	const origin = `http://${host}:${(server.address() as AddressInfo).port}`;
	return {
		origin,
		url: (path) => `${origin}${path}`,
		close: async () => {
			server.closeAllConnections();
			server.close();
			await once(server, "close");
		},
	};
}
