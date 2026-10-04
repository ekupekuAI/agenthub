import { expect, test } from '@playwright/test';

test('home loads and search finds a seeded skill', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'trust layer for agent skills',
  );
  await page.getByRole('searchbox', { name: 'Search' }).fill('changelog');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/q=changelog/);
  const result = page.getByRole('link', { name: 'changelog-writer' });
  await expect(result).toBeVisible();
  await result.click();
  await expect(page).toHaveURL(/\/skills\/changelog-writer$/);
});

test('skill page shows the install command and trust evidence', async ({ page }) => {
  await page.goto('/skills/web-testing');
  await expect(page.getByRole('heading', { level: 1, name: 'web-testing' })).toBeVisible();
  await expect(page.getByLabel('Install command')).toContainText('agenthub install web-testing');
  const trust = page.getByRole('region', { name: 'Trust evidence' });
  await expect(trust).toContainText('Content digest');
  await expect(trust).toContainText(/sha256:[a-f0-9]{64}/);
  await expect(trust).toContainText('Archive digest');
  await expect(trust).toContainText('Scanner');
  await expect(page.getByRole('region', { name: 'Compatibility' })).toContainText('Claude Code');
  await expect(page.getByRole('region', { name: 'Versions' })).toContainText('1.0.0');
  await expect(page.getByText('Verified publisher').first()).toBeVisible();
});

test('guidelines page has every section and a working table of contents', async ({ page }) => {
  await page.goto('/guidelines');
  for (const name of [
    '1. Quick start',
    '2. Installing safely',
    '3. Writing a safe skill',
    '4. Publishing rules',
    '5. Security model',
    '6. Reporting a malicious skill or vulnerability',
    '7. Troubleshooting',
  ]) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  }
  await page
    .getByRole('navigation', { name: 'On this page' })
    .getByRole('link', { name: /Security model/ })
    .click();
  await expect(page).toHaveURL(/#security-model$/);
  await expect(page.getByRole('cell', { name: 'net.download-exec' })).toBeVisible();
  await expect(page.getByText('security@agenthub.example').first()).toBeVisible();
});

test('admin requires login and then shows the quarantine queue', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByLabel('Admin token')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Quarantine queue/ })).toHaveCount(0);

  await page.getByLabel('Admin token').fill('definitely-not-the-admin-token-0000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'not valid' })).toBeVisible();

  await page.getByLabel('Admin token').fill(process.env.AGENTHUB_E2E_ADMIN_TOKEN as string);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Quarantine queue/ })).toBeVisible();
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name.includes('agenthub_admin'));
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Strict');
});

test('responses carry the CSP and other security headers', async ({ request }) => {
  const page = await request.get('/');
  const csp = page.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).not.toContain('unsafe-eval');
  expect(page.headers()['x-frame-options']).toBe('DENY');
  expect(page.headers()['x-content-type-options']).toBe('nosniff');
  expect(page.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(page.headers()['x-powered-by']).toBeUndefined();

  const api = await request.get('/api/v1/skills?q=web');
  expect(api.headers()['content-security-policy']).toContain("default-src 'none'");
  expect(api.headers()['x-frame-options']).toBe('DENY');
  const body = await api.json();
  expect(body.ok).toBe(true);
  expect(body.data.results.length).toBeGreaterThan(0);

  const missing = await request.get('/api/v1/skills/does-not-exist');
  expect(missing.status()).toBe(404);
  expect(await missing.json()).toEqual({
    ok: false,
    error: { code: 'NOT_FOUND', message: expect.any(String) },
  });
});

test('pages hydrate under the CSP and work at 375px', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy|Refused to/.test(msg.text())) {
      violations.push(msg.text());
    }
  });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/dashboard');
  await page.getByLabel('Publisher token').fill('ahp_not-a-real-token');
  await page.getByRole('button', { name: 'Show my skills' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'not valid' })).toBeVisible();

  for (const url of ['/', '/skills/web-testing', '/guidelines', '/publish']) {
    await page.goto(url);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow on ${url}`).toBeLessThanOrEqual(0);
  }
  expect(violations).toEqual([]);
});

test('publish form uploads through the server action and reports conflicts', async ({
  page,
  request,
}) => {
  const created = await request.post('/api/v1/admin/publishers', {
    headers: { authorization: `Bearer ${process.env.AGENTHUB_E2E_ADMIN_TOKEN}` },
    data: { displayName: `e2e-${Date.now()}`, verified: false },
  });
  expect(created.status()).toBe(201);
  const { token } = (await created.json()).data;

  const pkg = await request.get('/api/v1/skills/sql-review/download/1.0.0');
  expect(pkg.status()).toBe(200);

  await page.goto('/publish');
  await page.getByLabel('Publisher token').fill(token);
  await page.getByLabel('Package (.skillpkg)').setInputFiles({
    name: 'sql-review-1.0.0.skillpkg',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(await pkg.body()),
  });
  await page.getByRole('button', { name: 'Publish version' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'belongs to another publisher' }),
  ).toBeVisible();
});
