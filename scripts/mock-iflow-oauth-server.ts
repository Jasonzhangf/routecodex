import express from 'express';
import bodyParser from 'body-parser';

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const PORT = Number(process.env.OAUTH_PORT || 5601);

let lastDeviceCode = '';

app.post('/oauth/device/code', (req, res) => {
  lastDeviceCode = Math.random().toString(36).slice(2, 10);
  const userCode = 'ABCD-EFGH';
  const verification_uri = `http://localhost:${PORT}/verify`;
  const verification_uri_complete = `${verification_uri}?user_code=${encodeURIComponent(userCode)}`;
  res.setHeader('Content-Type', 'application/json');
  res.send({
    device_code: lastDeviceCode,
    user_code: userCode,
    verification_uri,
    verification_uri_complete,
    expires_in: 600,
    interval: 1,
  });
});

app.post('/oauth/token', (req, res) => {
  const gt = req.body.grant_type;
  res.setHeader('Content-Type', 'application/json');
  if (gt === 'urn:ietf:params:oauth:grant-type:device_code') {
    // Succeed immediately for tests
    res.send({
      access_token: 'mock_access_token',
      refresh_token: 'mock_refresh_token',
      token_type: 'Bearer',
      scope: 'openid profile email api',
      expires_in: 3600,
    });
    return;
  }
  if (gt === 'refresh_token') {
    res.send({
      access_token: 'mock_access_token_refreshed',
      refresh_token: 'mock_refresh_token_new',
      token_type: 'Bearer',
      scope: 'openid profile email api',
      expires_in: 3600,
    });
    return;
  }
  res.status(400).send({ error: 'unsupported_grant', error_description: gt });
});

app.get('/verify', (_req, res) => {
  res.status(200).send('Mock iFlow device verification page');
});

app.listen(PORT, () => {
  console.log(`[mock-iflow-oauth] listening on http://localhost:${PORT}`);
});

