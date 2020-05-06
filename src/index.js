const Apify = require('apify');
const _ = require('underscore');
const fs = require('fs');
const os = require("os");
const path = require("path");

const { log } = Apify.utils;
const crypto = require('crypto');
const { scrapePosts, handlePostsGraphQLResponse, scrapePost } = require('./posts');
const { scrapeComments, handleCommentsGraphQLResponse }  = require('./comments');
const { scrapeDetails }  = require('./details');
const { searchUrls } = require('./search');
const { getItemSpec, parseExtendOutputFunction } = require('./helpers');
const { GRAPHQL_ENDPOINT, ABORTED_RESOURCE_TYPES, SCRAPE_TYPES } = require('./consts');
const { initQueryIds } = require('./query_ids');
const errors = require('./errors');

async function main() {
    const input = await Apify.getInput();
    const {
        proxy,
        maxRequestRetries,
        loginCookies,
        directUrls = [],
        userDneCSV = `${__dirname}${path.sep}..${path.sep}dne.csv`,
        restrictedUserCSV = `${__dirname}${path.sep}..${path.sep}restricted.csv`,
        resultsType,
        resultsLimit = 200 } = input;

    const extendOutputFunction = parseExtendOutputFunction(input.extendOutputFunction);

    if (proxy.apifyProxyGroups && proxy.apifyProxyGroups.length === 0) delete proxy.apifyProxyGroups;

    await initQueryIds();

    let maxConcurrency = 1000;

    const usingLogin = loginCookies && Array.isArray(loginCookies);

    if (usingLogin) {
        await Apify.utils.log.warning('Cookies were used, setting maxConcurrency to 1 and using one proxy session!');
        maxConcurrency = 1;
        const session = crypto.createHash('sha256').update(JSON.stringify(loginCookies)).digest('hex').substring(0,16)
        if (proxy.useApifyProxy) proxy.apifyProxySession = `insta_session_${session}`;
    }

    let urls;
    if (Array.isArray(directUrls) && directUrls.length > 0) {
        urls = directUrls;
    } else {
        urls = await searchUrls(input);
    }

    if (urls.length === 0) {
        Apify.utils.log.info('No URLs to process');
        process.exit(0);
    }

    try {
        if (!resultsType) throw errors.typeIsRequired();
        if (!Object.values(SCRAPE_TYPES).includes(resultsType)) throw errors.unsupportedType(resultsType);
    } catch (error) {
        log.info('--  --  --  --  --');
        log.info(' ');
        Apify.utils.log.error('Run failed because the provided input is incorrect:');
        Apify.utils.log.error(error.message);
        log.info(' ');
        log.info('--  --  --  --  --');
        process.exit(1);
    }

    const requestListSources = urls.map(url => ({
        url,
        userData: { limit: resultsLimit },
    }));

    const requestList = await Apify.openRequestList('request-list', requestListSources);

    let cookies = loginCookies;

    const gotoFunction = async ({ request, page }) => {
        await page.setBypassCSP(true);
        if (cookies && Array.isArray(cookies)) {
            await page.setCookie(...cookies);
        } else if (input.loginUsername && input.loginPassword) {
            await login(input.loginUsername, input.loginPassword, page)
            cookies = await page.cookies();
        };

        await page.setRequestInterception(true);

        page.on('request', (req) => {
            if (
                ABORTED_RESOURCE_TYPES.includes(req.resourceType())
                || req.url().includes('map_tile.php')
                || req.url().includes('logging_client_events')
            ) {
                return req.abort();
            }

            req.continue();
        });

        page.on('response', async (response) => {
            const responseUrl = response.url();

            // Skip non graphql responses
            if (!responseUrl.startsWith(GRAPHQL_ENDPOINT)) return;

            // Wait for the page to parse it's data
            while (!page.itemSpec) await page.waitFor(100);

            switch (resultsType) {
                case SCRAPE_TYPES.POSTS: return handlePostsGraphQLResponse(page, response)
                    .catch(error => Apify.utils.log.error(error));
                case SCRAPE_TYPES.COMMENTS: return handleCommentsGraphQLResponse(page, response)
                    .catch(error => Apify.utils.log.error(error));
                // no default
            }
        });

        const response = await page.goto(request.url, {
            // itemSpec timeouts
            timeout: 60 * 1000,
        });

        if (usingLogin) {
            try {
                const viewerId = await page.evaluate(() => window._sharedData.config.viewerId);
                if (!viewerId) throw new Error('Failed to log in using cookies, they are probably no longer usable and you need to set new ones.');
            } catch (loginError) {
                await Apify.utils.log.error(loginError.message);
                process.exit(1);
            }
        }
        return response;
    };

    const handlePageFunction = async ({ page, puppeteerPool, request, response }) => {
        if (response.status() === 404) {
            Apify.utils.log.info(`Page "${request.url}" does not exist. Writing to ${userDneCSV}`);
            await fs.promises.appendFile(userDneCSV, `${request.url}${os.EOL}`)
            return;
        }

        const restrictedPageClassName = '.-cx-PRIVATE-GatedContentPage__userAvatarContainer';
        const wasRestricted = await page.waitForSelector(restrictedPageClassName, { timeout: 100 })
            .then(async () => {
                Apify.utils.log.info(`${page.url()}" seems to be restricted. Writing to ${restrictedUserCSV}`);
                await fs.promises.appendFile(restrictedUserCSV, `${request.url}${os.EOL}`);
            })
            .then(() => true)
            .catch(() => false);
        if (wasRestricted) {
            return;
        }

        // eslint-disable-next-line no-underscore-dangle
        await page.waitForFunction(() => (window.__initialData && !window.__initialData.pending && window.__initialData.data), { timeout: 200000 });
        // eslint-disable-next-line no-underscore-dangle
        const { pending, data } = await page.evaluate(() => window.__initialData);
        if (pending) throw new Error('Page took too long to load initial data, trying again.');
        if (!data || !data.entry_data) throw new Error('Page does not contain initial data, trying again.');
        const { entry_data: entryData } = data;

        if (entryData.LoginAndSignupPage) {
            await puppeteerPool.retire(page.browser());
            throw errors.redirectedToLogin();
        }

        const itemSpec = getItemSpec(entryData);

        let userResult = {};
        if (extendOutputFunction) {
            userResult = await page.evaluate((functionStr) => {
                // eslint-disable-next-line no-eval
                const f = eval(functionStr);
                return f();
            }, input.extendOutputFunction);
        }

        if (request.userData.label === 'postDetail') {
            const result = scrapePost(request, itemSpec, entryData);
            _.extend(result, userResult);

            await Apify.pushData(result);
        } else {
            page.itemSpec = itemSpec;

	    const privateUserCallback = async (privateUserUrl) => {
		Apify.utils.log.info(`${privateUserUrl}" seems to be private. Writing to ${userDneCSV}`);
		await fs.promises.appendFile(userDneCSV, `${request.url}${os.EOL}`)
	    }

            switch (resultsType) {
                case SCRAPE_TYPES.POSTS: return scrapePosts({ page, request, itemSpec, entryData, requestQueue, input, privateUserCallback });
                case SCRAPE_TYPES.COMMENTS: return scrapeComments(page, request, itemSpec, entryData);
                case SCRAPE_TYPES.DETAILS: return scrapeDetails({ input, request, request, itemSpec, entryData, page, proxy, userResult });
                default: throw new Error('Not supported');
            }
        }
    };

    if (proxy && proxy.apifyProxyGroups && proxy.apifyProxyGroups.length === 0) delete proxy.apifyProxyGroups;

    const requestQueue = await Apify.openRequestQueue();

    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        requestQueue,
        gotoFunction,
        maxRequestRetries,
        autoscaledPoolOptions: {
            snapshotterOptions: { maxBlockedMillis: 500 },
            systemStatusOptions: { maxEventLoopOverloadedRatio: 0.9 },
        },
        puppeteerPoolOptions: {
            maxOpenPagesPerInstance: 1,
            retireInstanceAfterRequestCount: 30,
        },
        launchPuppeteerOptions: {
            ...proxy,
            stealth: true,
            useChrome: true,
            ignoreHTTPSErrors: true,
            args: ['--enable-features=NetworkService', '--ignore-certificate-errors'],
        },
        maxConcurrency: 100,
        handlePageTimeoutSecs: 300 * 60, // Ex: 5 hours to crawl thousands of comments
        handlePageFunction,

        // If request failed 4 times then this function is executed.
        handleFailedRequestFunction: async ({ request }) => {
            Apify.utils.log.error(`${request.url}: Request ${request.url} failed 4 times`);
            await Apify.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
                '#error': request.url,
            });
        },
    });

    await crawler.run();
}

module.exports = main;
