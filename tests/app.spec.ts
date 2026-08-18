import { expect, test } from '@playwright/test';
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';

test('minimal Algoria chat is usable on desktop and mobile', async ({ page }, testInfo) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page).toHaveTitle('Algoria: Stellar Agent Chat');
  await expect(page.getByRole('heading', { name: 'What should Algoria do?' })).toBeVisible();
  const composer = page.getByLabel('Message Algoria');
  await expect(composer).toBeVisible();
  await expect(page.getByLabel('Execution safety policy')).toContainText('1 USDC hard cap');
  await expect(page.locator('body')).toContainText('Algoria');
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeEnabled({ timeout: 20_000 });
  await composer.fill('Hydration check');
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('home.png'), fullPage: true });
});

test('a casual greeting stays in the conversation instead of creating an agent failure', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Message Algoria').fill('hello');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(/What would you like to accomplish/)).toBeVisible();
  await expect(page.locator('.job-card')).toHaveCount(0);
  await expect(page.getByText('No compatible Stellar agent was found.')).toHaveCount(0);
});

test('conversation recommends one agent and keeps alternatives optional', async ({ page }) => {
  const resource = (overrides: Record<string, unknown> = {}) => ({
    key: 'stellar8004:42:https://research.example/summarize',
    source: 'stellar8004',
    agent8004Id: 42,
    name: 'Stellar Research',
    serviceName: 'Deep web research',
    description: 'Researches a topic and returns a concise, sourced answer.',
    endpoint: 'https://research.example/summarize',
    protocols: ['http', 'x402'],
    pricing: {
      scheme: 'exact', network: 'stellar:testnet', asset: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA', amountAtomic: '300000', amountUsdc: '0.03',
      payTo: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
    },
    evidence: { identity: 'on-chain-8004', reputationStatus: 'declared', declaredScore: 91, feedbackCount: 28, labels: ['8004 identity'] },
    executionStatus: 'ready',
    rawSourceIds: ['42'],
    ...overrides
  });

  await page.route('**/api/router', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        kind: 'agent-route',
        query: 'Research Stellar payments', partial: false, warnings: [], sources: [],
        resources: [
          resource(),
          resource({
            key: 'stellar8004:43:https://fast.example/research', agent8004Id: 43,
            name: 'Fast Research', serviceName: 'Fast research', endpoint: 'https://fast.example/research',
            description: 'Returns a faster summary with fewer sources.', rawSourceIds: ['fast'],
            pricing: undefined,
            protocols: ['http'],
            evidence: { identity: 'on-chain-8004', reputationStatus: 'unavailable', labels: ['8004 identity'] }
          })
        ]
      })
    });
  });

  await page.goto('/');
  await page.getByLabel('Message Algoria').fill('Research Stellar payments');
  await page.getByRole('button', { name: 'Send' }).click();

  const proposal = page.getByLabel('Recommended service');
  await expect(proposal).toContainText('Deep web research');
  await expect(proposal).toContainText('0.03 USDC');
  await expect(proposal).toContainText('Stellar 8004');
  const alternative = page.getByRole('button', { name: /Fast Research.*8004/ });
  await expect(alternative).toBeHidden();

  await page.getByRole('button', { name: /1 alternative/ }).click();
  await expect(alternative).toBeVisible();
  await alternative.click();
  await expect(proposal).toContainText('Fast research');
  await expect(proposal).toContainText('Live quote');
});

test('open discovery fails closed in lean v0', async ({ request }) => {
  const response = await request.get('/api/catalog/search?q=scrape');
  expect(response.status()).toBe(501);
  const body = await response.json();
  expect(body.code).toBe('unsupported-policy');
});

test('SEP-10 testnet session can persist a conversation', async ({ request }) => {
  const wallet = Keypair.random();
  const challengeResponse = await request.get(`/api/auth/sep10/challenge?account=${wallet.publicKey()}`);
  const challengeText = await challengeResponse.text();
  expect(challengeResponse.ok(), challengeText).toBeTruthy();
  const challenge = JSON.parse(challengeText);
  expect(challenge.networkPassphrase).toBe(Networks.TESTNET);
  const transaction = TransactionBuilder.fromXDR(challenge.transaction, Networks.TESTNET);
  transaction.sign(wallet);
  const verified = await request.post('/api/auth/sep10/verify', { data: { transaction: transaction.toXDR() } });
  expect(verified.ok()).toBeTruthy();
  const created = await request.post('/api/conversations', { data: { title: 'Playwright SEP-10 conversation' } });
  expect(created.status()).toBe(201);
  const conversation = (await created.json()).conversation;
  const listed = await request.get('/api/conversations');
  expect(listed.ok()).toBeTruthy();
  expect((await listed.json()).conversations.some((item: { id: string }) => item.id === conversation.id)).toBeTruthy();
});

test('a service that needs more detail offers an inline form instead of a dead end', async ({ page }) => {
  const wallet = Keypair.random();
  const challenge = await (await page.request.get(`/api/auth/sep10/challenge?account=${wallet.publicKey()}`)).json();
  const transaction = TransactionBuilder.fromXDR(challenge.transaction, Networks.TESTNET);
  transaction.sign(wallet);
  const verified = await page.request.post('/api/auth/sep10/verify', { data: { transaction: transaction.toXDR() } });
  expect(verified.ok(), await verified.text()).toBeTruthy();

  await page.route('**/api/router', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        kind: 'agent-route', query: 'classify this', partial: false, warnings: [], sources: [],
        resources: [{
          key: 'stellar8004:13:classify', source: 'stellar8004', agent8004Id: 13,
          name: 'Algoria Deterministic Test Provider', serviceName: 'HTTP x402 classify',
          description: 'Chooses one supplied label.', endpoint: 'https://provider.example/api/provider/classify',
          protocols: ['http', 'x402'],
          evidence: { identity: 'on-chain-8004', reputationStatus: 'declared', labels: [] },
          executionStatus: 'ready', rawSourceIds: ['13']
        }]
      })
    });
  });

  let prepareCalls = 0;
  const prompts: string[] = [];
  await page.route('**/api/jobs/prepare', async (route) => {
    prepareCalls += 1;
    prompts.push(JSON.parse(route.request().postData() ?? '{}').prompt ?? '');
    if (prepareCalls === 1) {
      await route.fulfill({
        status: 422, contentType: 'application/json',
        body: JSON.stringify({ message: 'Missing required input: /labels', missing: ['/labels'] })
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        token: 'stub-token', expiresAt: new Date(Date.now() + 300_000).toISOString(),
        arguments: { text: 'x', labels: ['billing', 'support'] },
        preview: {
          kind: 'http', endpoint: 'https://provider.example/api/provider/classify', method: 'POST',
          correlationId: '11111111-2222-4333-8444-555555555555',
          arguments: { text: 'x', labels: ['billing', 'support'] }
        }
      })
    });
  });

  await page.goto('/');
  await page.getByLabel('Message Algoria').fill('classify this support message');
  await page.getByRole('button', { name: 'Send' }).click();

  // The missing field is named in plain language, with an inline way to supply it.
  await expect(page.getByText('More detail needed')).toBeVisible();
  await expect(page.getByText(/still needs labels/)).toBeVisible();
  const detail = page.getByLabel('Add the missing detail');
  await expect(detail).toBeVisible();

  await detail.fill('Use labels: billing, support');
  await page.getByRole('button', { name: /Add detail & prepare/ }).click();

  // The detail is appended to the original prompt and the same service is re-prepared.
  await expect(page.getByText('Ready for review')).toBeVisible();
  expect(prepareCalls).toBe(2);
  expect(prompts[1]).toContain('classify this support message');
  expect(prompts[1]).toContain('Use labels: billing, support');
});

test('health exposes the enforced lean testnet profile', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.network).toBe('stellar:testnet');
  expect(body.environment).toBe('testnet');
  expect(body.features).toMatchObject({
    httpExecution: true,
    x402Payment: true,
    openCatalogDiscovery: false,
    bazaarRouting: false,
    mcpExecution: false,
    mppPayment: false,
    a2aExecution: false,
    feedback: true,
    // Open, and deliberately so: the gate means mainnet execution is permitted,
    // not that this deployment is mainnet. Deployment validation, not this flag,
    // is what keeps a testnet deployment on testnet.
    mainnet: true
  });
});

test('stellar.toml advertises the same testnet SEP-10 network', async ({ request }) => {
  const response = await request.get('/.well-known/stellar.toml');
  expect(response.ok()).toBeTruthy();
  const body = await response.text();
  expect(body).toContain(`NETWORK_PASSPHRASE=\"${Networks.TESTNET}\"`);
  expect(body).not.toContain(Networks.PUBLIC);
});
