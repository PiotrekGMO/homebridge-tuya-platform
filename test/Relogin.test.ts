/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, test, jest } from '@jest/globals';
import Crypto from 'crypto';
import TuyaOpenAPI from '../src/core/TuyaOpenAPI';

const log = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as any;

function makeApi() {
  const api = new TuyaOpenAPI('http://127.0.0.1', 'id', 'key', log);
  const post = jest.spyOn(api, 'post').mockImplementation((async () => ({
    success: true, result: { access_token: 'new', refresh_token: 'r2', uid: 'u', expire_time: 7200 },
  })) as any);
  const get = jest.spyOn(api, 'get').mockImplementation((async () => ({ success: false, code: 1010, msg: 'token is expired' })) as any);
  return { api, post, get };
}

function expire(api: TuyaOpenAPI) {
  api.tokenInfo = { access_token: 'old', refresh_token: 'r1', uid: 'u', expire: Date.now() - 1000 };
}

describe('TuyaOpenAPI relogin', () => {
  test('logs in again with the original password when the token cannot be refreshed', async () => {
    const { api, post } = makeApi();
    await api.homeLogin(48, 'user@example.com', 'secret', 'tuyaSmart');
    expect(post).toHaveBeenCalledTimes(1);
    const hash = Crypto.createHash('md5').update('secret').digest('hex');
    expect((post.mock.calls[0][1] as any).password).toBe(hash);

    const onRelogin = jest.fn();
    api.onRelogin = onRelogin;
    expire(api);
    await api._refreshAccessTokenIfNeed('/v1.0/devices');

    expect(post).toHaveBeenCalledTimes(2);
    expect((post.mock.calls[1][1] as any).password).toBe(hash); // hashed once, not twice
    expect(api.tokenInfo.access_token).toBe('new');
    expect(onRelogin).toHaveBeenCalledTimes(1);
  });

  test('does not hammer the login: once per interval, one login at a time', async () => {
    const { api, post } = makeApi();
    await api.homeLogin(48, 'user@example.com', 'secret', 'tuyaSmart');

    expire(api);
    await Promise.all([api.relogin(), api.relogin(), api._refreshAccessTokenIfNeed('/x')]);
    expect(post).toHaveBeenCalledTimes(2); // initial + exactly one relogin

    expire(api);
    await api._refreshAccessTokenIfNeed('/x');
    expect(post).toHaveBeenCalledTimes(2); // too soon after the previous relogin
  });

  test('repeats a request once after logging in again when the cloud rejects the token (1010)', async () => {
    const { api, post } = makeApi();
    await api.homeLogin(48, 'user@example.com', 'secret', 'tuya');
    const send = jest.spyOn(api as any, '_request')
      .mockResolvedValueOnce({ success: false, code: 1010, msg: 'token invalid' } as never)
      .mockResolvedValueOnce({ success: true, result: 'ok' } as never);
    post.mockClear();

    // the login itself goes through `post`, which is mocked, so the token changes to "new"
    api.tokenInfo.access_token = 'old';
    const res: any = await api.request('get', '/v1.0/devices');
    expect(res.result).toBe('ok');
    expect(send).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(1); // exactly one login
  });

  test('does not retry forever when logging in again is not possible', async () => {
    const { api } = makeApi();
    api.tokenInfo = { access_token: 'old', refresh_token: 'r', uid: 'u', expire: Date.now() + 3600000 };
    const send = jest.spyOn(api as any, '_request').mockResolvedValue({ success: false, code: 1010, msg: 'token invalid' } as never);
    const res: any = await api.request('get', '/v1.0/devices');
    expect(res.success).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('does nothing without a previous login', async () => {
    const { api, post } = makeApi();
    await api.relogin();
    expect(post).not.toHaveBeenCalled();
  });
});
