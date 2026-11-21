import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../../main/assets/restore-sso-session.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const baseURI = 'https://media.example/jellyfin/';
const server = { Id: 'server', UserId: 'user', AccessToken: 'test-token' };
const credentials = JSON.stringify({ Servers: [server] });

async function check(stored, fetch, autoLogin = 'true') {
    let destination;
    const storage = { jellyfin_credentials: stored, enableAutoLogin: autoLogin };
    await runInNewContext(script, {
        localStorage: { getItem: key => storage[key] ?? null },
        fetch, document: { baseURI }, URL, AbortController, setTimeout, clearTimeout,
        location: { replace: url => { destination = String(url); } }
    });
    return destination;
}

test('a verified saved session resumes at the selected server web index', async () => {
    let request;
    const destination = await check(credentials, async (url, options) => {
        if (url.pathname.endsWith('/System/Info/Public')) {
            assert.equal(options.headers, undefined);
            return { ok: true, json: async () => ({ Id: 'server' }) };
        }
        request = { url: String(url), options };
        return { ok: true, json: async () => ({ Id: 'user', ServerId: 'server' }) };
    });
    assert.equal(request.url, baseURI + 'Users/Me');
    assert.equal(request.options.headers.Authorization, 'MediaBrowser Token="test-token"');
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.mode, 'same-origin');
    assert.equal(destination, baseURI + 'web/index.html');
});

test('missing credentials, invalid storage and disabled auto-login go straight to SSO', async () => {
    let requests = 0;
    const fetch = () => { requests++; };
    for (const [stored, autoLogin] of [[null], ['bad json'], [credentials, 'false']]) {
        assert.equal(await check(stored, fetch, autoLogin), 'about:blank#sign-in');
    }
    assert.equal(requests, 0);
});

test('rejected credentials, mismatched identities and failed requests cannot resume a session', async () => {
    for (const fetch of [
        async () => ({ ok: false, status: 401 }),
        async () => ({ ok: true, json: async () => ({ Id: 'other', ServerId: 'server' }) }),
        async () => ({ ok: true, json: async () => ({ Id: 'user', ServerId: 'other' }) }),
        async () => { throw new Error('network failure'); }
    ]) {
        const validate = (url, options) => url.pathname.endsWith('/System/Info/Public')
            ? Promise.resolve({ ok: true, json: async () => ({ Id: 'server' }) })
            : fetch(url, options);
        assert.equal(await check(credentials, validate), 'about:blank#sign-in');
    }
});

test('a different installation on the same origin never receives the saved token', async () => {
    const requests = [];
    const destination = await check(credentials, async (url, options) => {
        requests.push(String(url));
        assert.equal(options.headers, undefined);
        return { ok: true, json: async () => ({ Id: 'different-server' }) };
    });
    assert.deepEqual(requests, [baseURI + 'System/Info/Public']);
    assert.equal(destination, 'about:blank#sign-in');
});
