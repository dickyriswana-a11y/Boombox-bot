const { execSync } = require('child_process');
const fs = require('fs');

function ensurePackageInstalled(packageName) {
    try {
        require.resolve(packageName);
        return;
    } catch { }

    console.log(`📦 [AutoInstall] Installing ${packageName}...`);

    try {
        execSync(`npm install ${packageName} --no-audit --no-fund`, {
            stdio: 'inherit',
            cwd: process.cwd(),
            timeout: 120000
        });
        console.log(`✅ [AutoInstall] ${packageName} installed!`);
    } catch (err) {
        console.error(`❌ [AutoInstall] Failed: ${err.message}`);
        console.log(`   Run: npm install ${packageName}`);
        throw err;
    }

    const Module = require('module');
    if (typeof Module._initPaths === 'function') Module._initPaths();
    Object.keys(require.cache).forEach(k => {
        if (k.includes(packageName)) delete require.cache[k];
    });
}

function ensurePackagesInstalled(packageNames) {
    for (const pkg of packageNames) {
        ensurePackageInstalled(pkg);
    }
}

module.exports = { ensurePackageInstalled, ensurePackagesInstalled };