/**
 * Fetches the obfuscated CDN vars JS from cloudnestra and extracts
 * the v1-v5 hostname mappings by running it in a sandboxed VM context.
 *
 * Usage: node extract_cdn_vars.js <cdn_js_url>
 * Output: JSON object like {"v1":"host1.com","v2":"host2.com",...}
 */

const vm = require('vm');
const https = require('https');

function fetch(url) {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': 'https://cloudnestra.com/'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function extractCdnVars(jsUrl) {
    const code = await fetch(jsUrl);

    // The obfuscated JS uses window['ZpQw9XkLmN8c3vR3'] as its string table key.
    // We run it in a sandboxed context with a mock window/document/navigator,
    // then intercept the Playerjs constructor call which receives the resolved vars.

    const captured = {};

    // Mock environment - just enough to not crash
    const mockWindow = {
        location: { href: 'https://cloudnestra.com/prorcp/test', hostname: 'cloudnestra.com' },
        parent: null,
        top: null,
        navigator: {
            userAgent: 'Mozilla/5.0',
            language: 'en-US',
            plugins: { namedItem: () => true },
            cookieEnabled: true,
            hardwareConcurrency: 4,
            deviceMemory: 8,
            platform: 'Win32',
            languages: ['en-US'],
        },
        document: {
            domain: 'cloudnestra.com',
            cookie: '',
            referrer: '',
            title: '',
            body: { appendChild: () => {}, removeChild: () => {} },
            createElement: () => ({ style: {}, onerror: null, onload: null, data: '', appendChild: () => {} }),
            getElementById: () => null,
        },
        screen: { width: 1920, height: 1080, colorDepth: 24 },
        localStorage: { getItem: () => null, setItem: () => {} },
        sessionStorage: { getItem: () => null, setItem: () => {} },
        addEventListener: () => {},
        removeEventListener: () => {},
        setTimeout: () => {},
        clearTimeout: () => {},
        setInterval: () => {},
        clearInterval: () => {},
        fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
        XMLHttpRequest: function() {
            return { open: () => {}, send: () => {}, setRequestHeader: () => {} };
        },
        // Intercept Playerjs - this is where v1-v5 get passed
        Playerjs: function(config) {
            if (config && config.file) {
                // Extract hostnames from the file string
                const matches = config.file.match(/https?:\/\/([^/]+)/g) || [];
                matches.forEach((m) => {
                    const host = m.replace(/https?:\/\//, '');
                    if (!Object.values(captured).includes(host)) {
                        captured['v' + (Object.keys(captured).length + 1)] = host;
                    }
                });
            }
        },
        // The key the obfuscated JS uses for its string table
        ZpQw9XkLmN8c3vR3: undefined,
    };

    // Self-reference
    mockWindow.window = mockWindow;
    mockWindow.parent = mockWindow;
    mockWindow.top = mockWindow;
    mockWindow.self = mockWindow;
    mockWindow.frames = mockWindow;
    mockWindow.globalThis = mockWindow;

    const sandbox = vm.createContext(mockWindow);

    // Wrap in try/catch - the obfuscated code will throw on missing DOM APIs
    // but we only need it to run far enough to decode the string table
    const wrappedCode = `
        try {
            ${code}
        } catch(e) {
            // expected - DOM APIs missing
        }
    `;

    try {
        vm.runInContext(wrappedCode, sandbox, { timeout: 5000 });
    } catch (e) {
        // ignore execution errors
    }

    // After running, the string table key should be populated
    // The decoded strings include the CDN hostnames
    // Extract them from the window object's string table
    const stringTableKey = Object.keys(sandbox).find(k => k.length > 10 && typeof sandbox[k] === 'string' && sandbox[k].length > 100);
    
    if (stringTableKey) {
        // The string table is a base64-encoded XOR-encrypted array
        // Try to find hostname patterns in the decoded strings
        const tableVal = sandbox[stringTableKey];
        // Look for hostname-like strings that got decoded
        const hostPattern = /[a-z0-9\-]{3,}\.[a-z0-9\-]{2,}\.[a-z]{2,6}/g;
        const found = [];
        let m;
        while ((m = hostPattern.exec(tableVal)) !== null) {
            found.push(m[0]);
        }
        if (found.length > 0 && Object.keys(captured).length === 0) {
            found.forEach((h, i) => { captured['v' + (i + 1)] = h; });
        }
    }

    return captured;
}

const jsUrl = process.argv[2];
if (!jsUrl) {
    process.stderr.write('Usage: node extract_cdn_vars.js <url>\n');
    process.exit(1);
}

extractCdnVars(jsUrl)
    .then(vars => {
        process.stdout.write(JSON.stringify(vars) + '\n');
    })
    .catch(err => {
        process.stderr.write('Error: ' + err.message + '\n');
        process.stdout.write('{}\n');
    });
