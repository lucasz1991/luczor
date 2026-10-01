<?php

// Test-only entry point. Never include the application's public/index.php: it
// loads the checkout's .env before an isolated environment can be selected.
declare(strict_types=1);
use App\Models\ApiKey;
use App\Models\Device;
use App\Models\User;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Foundation\Bootstrap\RegisterProviders;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Http;

function isolated_fail(string $reason): never
{
    if (PHP_SAPI !== 'cli') {
        http_response_code(503);
    }
    // Do not expose exception messages/config values in test evidence.
    echo json_encode(['ok' => false, 'reason' => $reason], JSON_THROW_ON_ERROR);
    exit(1);
}

$stage = 'environment';
try {
    $runRoot = realpath((string) getenv('LUCZOR_ISOLATED_RUN_ROOT'));
    $backendRoot = realpath((string) getenv('LUCZOR_ISOLATED_BACKEND_ROOT'));
    $runId = (string) getenv('LUCZOR_ISOLATED_RUN_ID');
    if ($runRoot === false || $backendRoot === false || ! preg_match('/^[a-f0-9-]{36}$/D', $runId)) {
        isolated_fail('invalid_isolated_identity');
    }
    $marker = json_decode((string) file_get_contents($runRoot.'/isolation.json'), true, 16, JSON_THROW_ON_ERROR);
    if (($marker['runId'] ?? null) !== $runId || ($marker['schema'] ?? null) !== 'luczor-isolated-functional-v1') {
        isolated_fail('invalid_isolation_marker');
    }
    $database = $runRoot.'/control-plane.sqlite';
    $storage = $runRoot.'/storage';
    $environment = $runRoot.'/environment';
    foreach ([$runRoot, $database, $storage, $environment] as $path) {
        if (is_link($path) || realpath($path) === false) {
            isolated_fail('unsafe_isolated_path');
        }
    }
    if (realpath($database) !== realpath((string) getenv('DB_DATABASE')) || getenv('APP_ENV') !== 'testing') {
        isolated_fail('invalid_database_environment');
    }
    $stage = 'bootstrap';
    require $backendRoot.'/vendor/autoload.php';
    $app = require $backendRoot.'/bootstrap/app.php';
    $app->useEnvironmentPath($environment);
    $app->loadEnvironmentFrom('.env');
    $app->useStoragePath($storage);
    $app->beforeBootstrapping(RegisterProviders::class, function ($app) use ($database, $runRoot): void {
        $expected = [
            'app.env' => 'testing', 'app.debug' => false,
            'database.default' => 'sqlite', 'cache.default' => 'array',
            'session.driver' => 'array', 'queue.default' => 'sync',
            'mail.default' => 'array', 'broadcasting.default' => 'null',
            'filesystems.default' => 'local',
        ];
        foreach ($expected as $key => $value) {
            if ($app['config']->get($key) !== $value) {
                isolated_fail('effective_config_mismatch');
            }
        }
        if (realpath($app['config']->get('database.connections.sqlite.database')) !== realpath($database)
            || $app['config']->get('database.connections.sqlite.url')
            || realpath(dirname($app->getCachedConfigPath())) !== realpath($runRoot.'/cache')) {
            isolated_fail('effective_database_or_cache_mismatch');
        }
        // No extra connection may accidentally reach a default local MySQL or Redis instance.
        $app['config']->set('database.connections', ['sqlite' => $app['config']->get('database.connections.sqlite')]);
        // Horizon reads connection metadata during provider boot even with a
        // synchronous queue. Keep inert metadata, never a real Redis endpoint.
        $app['config']->set('database.redis', ['client' => 'phpredis', 'default' => ['host' => '127.0.0.1', 'port' => 0, 'database' => 0]]);
    });
    $kernel = $app->make(Kernel::class);
    $kernel->bootstrap();
    Http::preventStrayRequests();

    if (PHP_SAPI === 'cli') {
        if (($argv[1] ?? '') !== 'initialize' || filesize($database) !== 0) {
            isolated_fail('refusing_nonempty_database');
        }
        $stage = 'migrate';
        $result = $kernel->call('migrate', ['--force' => true, '--no-interaction' => true]);
        if ($result !== 0) {
            isolated_fail('isolated_migration_failed');
        }
        $stage = 'seed';
        $user = new User;
        $user->forceFill([
            'name' => 'Luczor Isolated Test', 'email' => $runId.'@luczor.invalid',
            'email_verified_at' => now(), 'role' => 'user', 'status' => true,
            'password' => Hash::make(bin2hex(random_bytes(32))),
        ])->save();
        $minted = ApiKey::mint([
            'user_id' => $user->id, 'name' => 'Isolated functional test',
            'abilities' => ['settings.read'], 'active' => true,
            'device_id' => 'isolated-'.$runId, 'device_name' => 'Luczor Isolated Test',
            'expires_at' => now()->addHour(), 'meta' => ['isolated_run_id' => $runId],
        ]);
        Device::create([
            'user_id' => $user->id, 'api_key_id' => $minted['model']->id,
            'device_id' => 'isolated-'.$runId, 'name' => 'Luczor Isolated Test', 'status' => 'online',
            'meta' => ['isolated_run_id' => $runId],
        ]);
        $stage = 'token';
        $tokenFile = fopen($runRoot.'/device-token.secret', 'x');
        if ($tokenFile === false || fwrite($tokenFile, $minted['plain']) !== strlen($minted['plain'])) {
            isolated_fail('private_token_write_failed');
        }
        fclose($tokenFile);
        chmod($runRoot.'/device-token.secret', 0600);
        echo json_encode(['ok' => true, 'runId' => $runId, 'users' => User::count()], JSON_THROW_ON_ERROR);
        exit;
    }

    $stage = 'http';
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $path === '/__isolated/status') {
        header('Content-Type: application/json');
        echo json_encode(['ok' => true, 'runId' => $runId, 'users' => User::count()], JSON_THROW_ON_ERROR);
        exit;
    }
    // The test server exposes only the two real API paths used by this smoke.
    // This is deliberately not a clone of the production API surface.
    if ($_SERVER['REQUEST_METHOD'] !== 'GET' || ! in_array($path, ['/api/v1/health', '/api/v1/preferences'], true)) {
        http_response_code(404);
        echo '{"ok":false,"reason":"outside_isolated_test_contract"}';
        exit;
    }
    $httpKernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
    $request = Request::capture();
    $response = $httpKernel->handle($request);
    $response->send();
    $httpKernel->terminate($request, $response);
} catch (Throwable $error) {
    // Class + fixed stage are useful without dumping SQL, headers or env values.
    if (PHP_SAPI !== 'cli') {
        http_response_code(503);
    }
    echo json_encode(['ok' => false, 'reason' => 'isolated_control_plane_failed', 'stage' => $stage, 'exception' => get_class($error), 'source' => basename($error->getFile()).':'.$error->getLine()], JSON_THROW_ON_ERROR);
    exit(1);
}
