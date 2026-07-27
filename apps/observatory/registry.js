// Curated public endpoints for the SHIFTGRAPH public API observatory (Track A).
//
// Selection rules (white-hat, ToS-friendly):
//   - Public and no-auth. No key circumvention, no scraping of private data.
//   - JSON where possible (so structural profiling is meaningful).
//   - Prefer surfaces that are meant to be polled.
//   - One request per endpoint per day. Nothing here is a load generator.
//
// Backbone: Atlassian Statuspage v2 exposes a standardized public
// `/api/v2/summary.json` on hundreds of providers. It is designed for polling,
// returns rich structure (page, status, components[], incidents[]), and genuinely
// changes over time (incidents open/resolve, component sets shift). That makes it
// the ideal longitudinal signal source for a cross-provider observatory.
//
// Some hosts below are best-effort; a wrong subdomain simply records as a failed
// observation and gets pruned after the first run. Failures are data, not noise.
//
// ---------------------------------------------------------------------------
// THIS REGISTRY IS IDENTITY. Read before editing.
//
// Every entry's URL feeds the same path templating that produces `coi_hash`, so
// an operation is keyed by its host and path template. Editing an existing URL
// does not update that operation, it ABANDONS it: observations land on a new
// hash, the old row goes quiet, and the saved baseline keeps comparing against
// a surface nothing reports to any more. The drift history forks in silence,
// which is the one failure mode this project exists to make impossible.
//
// So growth here is ADDITIVE. Append new entries; never rewrite an existing
// URL to a "better" one. If an endpoint genuinely must move, treat it as a
// retirement plus an addition and expect the baseline to show one operation
// disappearing and another arriving, because that is the truth of what happened.
//
// New entries are expected to appear once as `new_operation_count` on the next
// compare. That is not drift, and the ledger records the two separately.
// ---------------------------------------------------------------------------
//
// WHAT BREADTH IS FOR, and what it is not. Phase 0 has to answer how often
// third-party contracts actually change, and an honest reading of that number
// depends far more on how many DISTINCT contracts are watched than on how many
// requests are made. Two hundred Statuspage endpoints are two hundred instances
// of one schema: nearly free to add, genuinely useful as cross-company corpus,
// but weak evidence that contracts move. Twenty distinct package-registry and
// dev-platform schemas are worth more, because each is a separate contract with
// its own maintainers and its own release cadence.
//
// The additions below are therefore weighted toward surfaces that are shaped
// like the dependencies our customers actually assemble products from, and that
// are maintained by teams who ship: package registries first, dev platforms and
// model hubs next, civic and scientific APIs for schema diversity, status pages
// last as cheap breadth.

const STATUSPAGE_HOSTS = [
  ['github', 'www.githubstatus.com'],
  ['openai', 'status.openai.com'],
  ['anthropic', 'status.anthropic.com'],
  ['cloudflare', 'www.cloudflarestatus.com'],
  ['supabase', 'status.supabase.com'],
  ['vercel', 'www.vercel-status.com'],
  ['netlify', 'www.netlifystatus.com'],
  ['discord', 'discordstatus.com'],
  ['reddit', 'www.redditstatus.com'],
  ['dropbox', 'status.dropbox.com'],
  ['twilio', 'status.twilio.com'],
  ['sendgrid', 'status.sendgrid.com'],
  ['coinbase', 'status.coinbase.com'],
  ['atlassian', 'status.atlassian.com'],
  ['bitbucket', 'bitbucket.status.atlassian.com'],
  ['sentry', 'status.sentry.io'],
  ['npm', 'status.npmjs.org'],
  ['digitalocean', 'status.digitalocean.com'],
  ['datadog', 'status.datadoghq.com'],
  ['mongodb', 'status.mongodb.com'],
  ['hubspot', 'status.hubspot.com'],
  ['segment', 'status.segment.com'],
  ['algolia', 'status.algolia.com'],
  ['squarespace', 'status.squarespace.com'],
  ['zoom', 'status.zoom.us'],
  ['cloudinary', 'status.cloudinary.com'],
  ['figma', 'status.figma.com'],
  ['render', 'status.render.com'],
  ['circleci', 'status.circleci.com'],
  ['linear', 'status.linear.app'],
  ['notion', 'status.notion.so'],

  // --- appended 2026-07-26 (breadth pass). Every host below answered
  //     /api/v2/summary.json with real Statuspage JSON on the first sweep.
  //     Nineteen more were tried and removed the same day: some 404 or 401
  //     because the company self-hosts its status page, and some return the
  //     HTML page rather than the API because they are not Statuspage at all
  //     (fastly, heroku, railway, neon, databricks, docker, okta, auth0,
  //     pagerduty, zendesk, intercom, mailchimp, postmark, resend, vonage,
  //     stripe, paddle, posthog, loom). They were dropped rather than kept as
  //     permanent failures: an endpoint that can never produce a shape is not
  //     an observation, it is padding on the endpoint count.
  ['flyio', 'status.flyio.net'],
  ['planetscale', 'www.planetscalestatus.com'],
  ['upstash', 'status.upstash.com'],
  ['cockroachlabs', 'status.cockroachlabs.cloud'],
  ['elastic', 'status.elastic.co'],
  ['snowflake', 'status.snowflake.com'],
  ['confluent', 'status.confluent.cloud'],
  ['gitpod', 'www.gitpodstatus.com'],
  ['jfrog', 'status.jfrog.io'],

  // --- identity, auth, developer SaaS ---
  ['clerk', 'status.clerk.com'],
  ['workos', 'status.workos.com'],
  ['newrelic', 'status.newrelic.com'],
  ['launchdarkly', 'status.launchdarkly.com'],
  ['grafana', 'status.grafana.com'],
  ['honeycomb', 'status.honeycomb.io'],
  ['bugsnag', 'status.bugsnag.com'],

  // --- comms, email, media ---
  ['mailgun', 'status.mailgun.com'],
  ['mux', 'status.mux.com'],

  // --- payments + fintech ---
  ['plaid', 'status.plaid.com'],
  ['chargebee', 'status.chargebee.com'],
  ['kraken', 'status.kraken.com'],

  // --- product + content SaaS ---
  ['airtable', 'status.airtable.com'],
  ['asana', 'status.asana.com'],
  ['trello', 'trello.status.atlassian.com'],
  ['webflow', 'status.webflow.com'],
  ['contentful', 'www.contentfulstatus.com'],
  ['sanity', 'status.sanity.io'],
  ['amplitude', 'status.amplitude.com'],
  ['mixpanel', 'status.mixpanel.com'],
  ['shopify', 'www.shopifystatus.com'],
  ['bigcommerce', 'status.bigcommerce.com'],
  ['calendly', 'www.calendlystatus.com'],
  ['typeform', 'status.typeform.com'],
  ['miro', 'status.miro.com']
];

/** Compact constructor for appended groups: one line per endpoint. */
const api = (provider, category, entries) =>
  entries.map(([id, url]) => ({ id, provider, category, method: 'GET', url }));

// Direct no-auth JSON APIs across categories. These are stable, documented,
// widely-used public endpoints.
//
// The first block is the original 32, preserved verbatim: their operations
// carry baseline history and their URLs must not be rewritten (see the identity
// note above). Everything after the marker was appended in the breadth pass.
const DIRECT = [
  // dev registries / package ecosystems
  { id: 'github-repo-react', provider: 'github', category: 'dev-registry', url: 'https://api.github.com/repos/facebook/react' },
  { id: 'github-repo-node', provider: 'github', category: 'dev-registry', url: 'https://api.github.com/repos/nodejs/node' },
  { id: 'github-ratelimit', provider: 'github', category: 'dev-registry', url: 'https://api.github.com/rate_limit' },
  { id: 'npm-react', provider: 'npm', category: 'dev-registry', url: 'https://registry.npmjs.org/react' },
  { id: 'npm-express', provider: 'npm', category: 'dev-registry', url: 'https://registry.npmjs.org/express' },
  { id: 'pypi-requests', provider: 'pypi', category: 'dev-registry', url: 'https://pypi.org/pypi/requests/json' },
  { id: 'pypi-django', provider: 'pypi', category: 'dev-registry', url: 'https://pypi.org/pypi/django/json' },
  { id: 'crates-serde', provider: 'crates', category: 'dev-registry', url: 'https://crates.io/api/v1/crates/serde' },
  { id: 'dockerhub-nginx', provider: 'dockerhub', category: 'dev-registry', url: 'https://hub.docker.com/v2/repositories/library/nginx' },
  { id: 'dockerhub-postgres', provider: 'dockerhub', category: 'dev-registry', url: 'https://hub.docker.com/v2/repositories/library/postgres' },

  // finance / fx / crypto
  { id: 'coingecko-ping', provider: 'coingecko', category: 'crypto', url: 'https://api.coingecko.com/api/v3/ping' },
  { id: 'coingecko-price', provider: 'coingecko', category: 'crypto', url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd' },
  { id: 'coinbase-rates-btc', provider: 'coinbase', category: 'crypto', url: 'https://api.coinbase.com/v2/exchange-rates?currency=BTC' },
  { id: 'coinbase-currencies', provider: 'coinbase', category: 'crypto', url: 'https://api.coinbase.com/v2/currencies' },
  { id: 'frankfurter-latest', provider: 'frankfurter', category: 'fx', url: 'https://api.frankfurter.app/latest' },

  // weather / geo
  { id: 'openmeteo-forecast', provider: 'open-meteo', category: 'weather', url: 'https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current_weather=true' },
  { id: 'openmeteo-geocode', provider: 'open-meteo', category: 'geo', url: 'https://geocoding-api.open-meteo.com/v1/search?name=Berlin&count=1' },
  { id: 'ipapi-json', provider: 'ip-api', category: 'geo', url: 'http://ip-api.com/json' },

  // reference / content
  { id: 'restcountries-us', provider: 'restcountries', category: 'reference', url: 'https://restcountries.com/v3.1/alpha/us' },
  { id: 'wikipedia-summary', provider: 'wikimedia', category: 'reference', url: 'https://en.wikipedia.org/api/rest_v1/page/summary/Application_programming_interface' },
  { id: 'openlibrary-work', provider: 'openlibrary', category: 'reference', url: 'https://openlibrary.org/works/OL45804W.json' },
  { id: 'pokeapi-1', provider: 'pokeapi', category: 'reference', url: 'https://pokeapi.co/api/v2/pokemon/1' },
  { id: 'hackernews-top', provider: 'hackernews', category: 'content', url: 'https://hacker-news.firebaseio.com/v0/topstories.json' },
  { id: 'hackernews-item', provider: 'hackernews', category: 'content', url: 'https://hacker-news.firebaseio.com/v0/item/1.json' },

  // sample / testing services (stable shapes, good control group)
  { id: 'jsonplaceholder-post', provider: 'jsonplaceholder', category: 'sample', url: 'https://jsonplaceholder.typicode.com/posts/1' },
  { id: 'jsonplaceholder-users', provider: 'jsonplaceholder', category: 'sample', url: 'https://jsonplaceholder.typicode.com/users' },
  { id: 'httpbin-json', provider: 'httpbin', category: 'sample', url: 'https://httpbin.org/json' },
  { id: 'httpbin-get', provider: 'httpbin', category: 'sample', url: 'https://httpbin.org/get' },
  { id: 'dogceo-breeds', provider: 'dog-ceo', category: 'sample', url: 'https://dog.ceo/api/breeds/list/all' },
  { id: 'catfact', provider: 'catfact', category: 'sample', url: 'https://catfact.ninja/fact' },
  { id: 'chucknorris', provider: 'chucknorris', category: 'sample', url: 'https://api.chucknorris.io/jokes/random' },
  { id: 'adviceslip', provider: 'adviceslip', category: 'sample', url: 'https://api.adviceslip.com/advice' },

  // =========================================================================
  // APPENDED 2026-07-26 (breadth pass). Everything below is new identity.
  // =========================================================================

  // --- Package registries. The closest public analogue to what our customers
  //     depend on, and where a contract change is most likely to be real. Note
  //     the deliberate mix of DIFFERENT endpoint shapes per registry (packument
  //     vs version manifest vs search vs downloads); a second package name is
  //     the same schema again, a different endpoint is a different contract.
  ...api('npm', 'dev-registry', [
    ['npm-react-latest', 'https://registry.npmjs.org/react/latest'],
    ['npm-typescript-latest', 'https://registry.npmjs.org/typescript/latest'],
    ['npm-search', 'https://registry.npmjs.org/-/v1/search?text=react&size=3'],
    ['npm-downloads-point', 'https://api.npmjs.org/downloads/point/last-week/react'],
    ['npm-downloads-range', 'https://api.npmjs.org/downloads/range/last-week/express']
  ]),
  ...api('pypi', 'dev-registry', [
    ['pypi-requests-pinned', 'https://pypi.org/pypi/requests/2.31.0/json']
  ]),
  ...api('crates', 'dev-registry', [
    ['crates-serde-versions', 'https://crates.io/api/v1/crates/serde/versions'],
    ['crates-serde-owners', 'https://crates.io/api/v1/crates/serde/owners'],
    ['crates-summary', 'https://crates.io/api/v1/summary']
  ]),
  ...api('rubygems', 'dev-registry', [
    ['rubygems-rails', 'https://rubygems.org/api/v1/gems/rails.json'],
    ['rubygems-rails-versions', 'https://rubygems.org/api/v1/versions/rails.json']
  ]),
  ...api('packagist', 'dev-registry', [
    ['packagist-symfony-console', 'https://repo.packagist.org/p2/symfony/console.json'],
    ['packagist-laravel-framework', 'https://repo.packagist.org/p2/laravel/framework.json']
  ]),
  ...api('golang', 'dev-registry', [
    ['go-gin-latest', 'https://proxy.golang.org/github.com/gin-gonic/gin/@latest']
  ]),
  ...api('hex', 'dev-registry', [
    ['hex-phoenix', 'https://hex.pm/api/packages/phoenix']
  ]),
  ...api('nuget', 'dev-registry', [
    ['nuget-index', 'https://api.nuget.org/v3/index.json']
  ]),
  ...api('maven', 'dev-registry', [
    ['maven-search-guava', 'https://search.maven.org/solrsearch/select?q=g:com.google.guava&rows=3&wt=json']
  ]),
  ...api('dockerhub', 'dev-registry', [
    ['dockerhub-nginx-tags', 'https://hub.docker.com/v2/repositories/library/nginx/tags?page_size=3']
  ]),
  ...api('homebrew', 'dev-registry', [
    ['brew-git', 'https://formulae.brew.sh/api/formula/git.json'],
    ['brew-node', 'https://formulae.brew.sh/api/formula/node.json'],
    ['brew-cask-firefox', 'https://formulae.brew.sh/api/cask/firefox.json']
  ]),
  ...api('depsdev', 'dev-registry', [
    ['depsdev-npm-react', 'https://api.deps.dev/v3alpha/systems/npm/packages/react'],
    ['depsdev-pypi-requests', 'https://api.deps.dev/v3alpha/systems/pypi/packages/requests'],
    ['depsdev-cargo-serde', 'https://api.deps.dev/v3alpha/systems/cargo/packages/serde']
  ]),
  ...api('endoflife', 'dev-registry', [
    ['eol-nodejs', 'https://endoflife.date/api/nodejs.json'],
    ['eol-python', 'https://endoflife.date/api/python.json'],
    ['eol-postgresql', 'https://endoflife.date/api/postgresql.json'],
    ['eol-ubuntu', 'https://endoflife.date/api/ubuntu.json']
  ]),

  // --- Developer platforms. Many distinct response shapes per provider, and
  //     teams that ship continuously. GitHub is held well under its 60/hour
  //     unauthenticated rate limit.
  // A USER-OWNED repo, added 2026-07-26 for a specific reason worth keeping.
  //
  // GET /repos/{owner}/{repo} returns 86 fields for facebook/react and 84 for
  // octocat/Hello-World, at the same moment with the same credentials. The
  // extras are `custom_properties` and `organization`, which exist only because
  // react is owned by an organisation. Every GitHub repo we watched was
  // org-owned, so folding them together could never reveal that those two
  // fields are conditional, and a generated type marked them required.
  //
  // Breadth of ENDPOINTS was never the whole problem. Breadth of RESOURCES
  // within one endpoint is a second axis, and a corpus blind on that axis
  // produces types that are confidently too narrow.
  ...api('github', 'dev-platform', [
    ['github-repo-hello-world', 'https://api.github.com/repos/octocat/Hello-World'],
    ['github-repo-next', 'https://api.github.com/repos/vercel/next.js'],
    ['github-release-latest', 'https://api.github.com/repos/facebook/react/releases/latest'],
    ['github-tags', 'https://api.github.com/repos/facebook/react/tags?per_page=3'],
    ['github-languages', 'https://api.github.com/repos/facebook/react/languages'],
    ['github-topics', 'https://api.github.com/repos/facebook/react/topics'],
    ['github-license', 'https://api.github.com/repos/facebook/react/license'],
    ['github-contributors', 'https://api.github.com/repos/facebook/react/contributors?per_page=3'],
    ['github-org', 'https://api.github.com/orgs/github'],
    ['github-user', 'https://api.github.com/users/torvalds'],
    ['github-meta', 'https://api.github.com/meta'],
    ['github-gitignore-templates', 'https://api.github.com/gitignore/templates'],
    ['github-licenses', 'https://api.github.com/licenses'],
    ['github-license-mit', 'https://api.github.com/licenses/mit'],
    ['github-versions', 'https://api.github.com/versions']
  ]),
  // GitLab's project endpoint is public; releases (403) and metadata (401)
  // require a token, so they were dropped rather than kept as standing failures.
  ...api('gitlab', 'dev-platform', [
    ['gitlab-project', 'https://gitlab.com/api/v4/projects/278964']
  ]),
  ...api('codeberg', 'dev-platform', [
    ['codeberg-repo', 'https://codeberg.org/api/v1/repos/forgejo/forgejo'],
    ['codeberg-version', 'https://codeberg.org/api/v1/version']
  ]),
  ...api('huggingface', 'model-hub', [
    ['hf-models', 'https://huggingface.co/api/models?limit=3'],
    ['hf-model-bert', 'https://huggingface.co/api/models/bert-base-uncased'],
    ['hf-datasets', 'https://huggingface.co/api/datasets?limit=3'],
    ['hf-dataset-squad', 'https://huggingface.co/api/datasets/squad']
  ]),

  // --- Finance, crypto, FX. High-frequency surfaces with well-specified
  //     contracts and real versioning discipline.
  ...api('coingecko', 'crypto', [
    ['coingecko-coin-bitcoin', 'https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false']
  ]),
  ...api('coinbase', 'crypto', [
    ['coinbase-time', 'https://api.coinbase.com/v2/time']
  ]),
  ...api('kraken', 'crypto', [
    ['kraken-ticker', 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD'],
    ['kraken-assetpairs', 'https://api.kraken.com/0/public/AssetPairs?pair=XBTUSD'],
    ['kraken-time', 'https://api.kraken.com/0/public/Time']
  ]),
  ...api('frankfurter', 'fx', [
    ['frankfurter-currencies', 'https://api.frankfurter.app/currencies']
  ]),
  ...api('worldbank', 'econ', [
    ['worldbank-country-us', 'https://api.worldbank.org/v2/country/US?format=json']
  ]),

  // --- Civic, scientific, geospatial. Chosen for SCHEMA DIVERSITY: deeply
  //     nested GeoJSON, envelope-wrapped collections, and flat records each
  //     profile differently, which exercises the engine's shape analysis
  //     instead of re-observing one object shape a hundred times.
  ...api('usgs', 'geo', [
    ['usgs-quakes-query', 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit=3'],
    ['usgs-quakes-hour', 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson']
  ]),
  ...api('open-meteo', 'environment', [
    ['openmeteo-airquality', 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=52.52&longitude=13.41&current=pm10']
  ]),
  ...api('noaa', 'weather', [
    ['nws-points', 'https://api.weather.gov/points/39.7456,-97.0892']
  ]),
  ...api('carbonintensity', 'energy', [
    ['carbon-intensity', 'https://api.carbonintensity.org.uk/intensity']
  ]),
  ...api('gbif', 'science', [
    ['gbif-species', 'https://api.gbif.org/v1/species/5231190'],
    ['gbif-occurrence-search', 'https://api.gbif.org/v1/occurrence/search?limit=2']
  ]),
  ...api('inaturalist', 'science', [
    ['inat-taxa', 'https://api.inaturalist.org/v1/taxa/1']
  ]),
  // api.spacexdata.com returned 525 (origin TLS failure) on both endpoints and
  // has a long history of being down; dropped rather than baselined as broken.
  ...api('spacedevs', 'science', [
    ['spacedevs-upcoming', 'https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=2']
  ]),
  ...api('nager', 'reference', [
    ['nager-holidays-us', 'https://date.nager.at/api/v3/PublicHolidays/2026/US'],
    ['nager-countries', 'https://date.nager.at/api/v3/AvailableCountries']
  ]),
  ...api('sunrise-sunset', 'reference', [
    ['sunrise-sunset', 'https://api.sunrise-sunset.org/json?lat=36.7201600&lng=-4.4203400']
  ]),
  ...api('nhtsa', 'reference', [
    ['nhtsa-manufacturers', 'https://vpic.nhtsa.dot.gov/api/vehicles/getallmanufacturers?format=json&page=1']
  ]),
  ...api('openfda', 'reference', [
    ['fda-drug-event', 'https://api.fda.gov/drug/event.json?limit=1'],
    ['fda-food-enforcement', 'https://api.fda.gov/food/enforcement.json?limit=1']
  ]),

  // --- Reference, knowledge, content. Stable envelopes, moving payloads.
  ...api('wikimedia', 'reference', [
    ['wikimedia-bare', 'https://api.wikimedia.org/core/v1/wikipedia/en/page/Earth/bare'],
    ['wikidata-entity', 'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q42&format=json']
  ]),
  ...api('openlibrary', 'content', [
    ['openlibrary-search', 'https://openlibrary.org/search.json?q=api&limit=2']
  ]),
  ...api('restcountries', 'reference', [
    ['restcountries-japan', 'https://restcountries.com/v3.1/name/japan']
  ]),
  ...api('metmuseum', 'content', [
    ['met-object', 'https://collectionapi.metmuseum.org/public/collection/v1/objects/45734'],
    ['met-departments', 'https://collectionapi.metmuseum.org/public/collection/v1/departments']
  ]),
  ...api('artic', 'content', [
    ['artic-artworks', 'https://api.artic.edu/api/v1/artworks?limit=2']
  ]),
  ...api('tvmaze', 'content', [
    ['tvmaze-show', 'https://api.tvmaze.com/shows/1']
  ]),
  ...api('pokeapi', 'sample', [
    ['pokeapi-species-1', 'https://pokeapi.co/api/v2/pokemon-species/1']
  ]),
  ...api('rickandmorty', 'sample', [
    ['rickandmorty-character', 'https://rickandmortyapi.com/api/character/1']
  ]),
  ...api('ipify', 'reference', [
    ['ipify-json', 'https://api.ipify.org?format=json']
  ])
];

export const ENDPOINTS = [
  ...STATUSPAGE_HOSTS.map(([id, host]) => ({
    id: `status-${id}`,
    provider: id,
    category: 'status-page',
    method: 'GET',
    url: `https://${host}/api/v2/summary.json`
  })),
  ...DIRECT.map(e => ({ method: 'GET', ...e }))
];

export const REGISTRY_META = {
  statuspage_count: STATUSPAGE_HOSTS.length,
  direct_count: DIRECT.length,
  total: ENDPOINTS.length,
  providers: [...new Set(ENDPOINTS.map(e => e.provider))].length,
  categories: [...new Set(ENDPOINTS.map(e => e.category))].length,
  /**
   * Distinct non-statuspage providers. This is the count that carries
   * evidentiary weight for Phase 0, because status pages share one schema.
   */
  distinct_contract_providers: [...new Set(DIRECT.map(e => e.provider))].length
};
