/**
 * LEELA V1 — Source Code Packager
 *
 * This script identifies the main component files of the project,
 * ignores cruft, logs, build artifacts, and secrets, and
 * creates a clean ZIP file of the source code that can be easily
 * shared with other developers.
 *
 * Usage: node package_source.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const TEMP_DIR = path.join(ROOT, 'LeelaV1_Source');
const OUT_ZIP = path.join(ROOT, 'LeelaV1_SourceCode.zip');

// Exact files and directories that make up the core project source
const ALLOWED_COMPONENTS = new Set([
    // Core Application
    'main.js',
    'package.json',
    'package-lock.json',

    // Modules
    'activity_logger.js',
    'cleanup.js',
    'platform_helper.js',
    'secret_manager.js',
    'settings_manager.js',
    'transcribe_sarvam.js',
    'transcribe_sarvam_batch.js',

    // Tools & Build Scripts
    'build_protected.js',
    'secure_build.js',
    'electron_compiler.js',
    'package_source.js', // this script

    // Docs
    'README.md',
    'README_PORTABLE.md',
    'LICENSE',
    'CONSTITUTION.md',
    '.gitignore',

    // Windows Integration Scripts
    'run-leelav1.bat',
    'launch_leela.vbs',
    'create_public_shortcut.vbs',
    'create_shortcut.vbs',
    'create_shortcut_explicit.vbs',
    'add_to_start_menu.ps1',
    'upload_and_paste.ps1',

    // Directories
    'assets',
    'optimizer',
    'renderer'
]);

// ── 1. Create temporary staging directory ────────────────────
console.log('── 1. Preparing Staging Directory ───────────────────');
if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEMP_DIR, { recursive: true });
console.log(`Created clean staging folder: ${TEMP_DIR}`);

// ── 2. Copy allowed files/folders safely ─────────────────────
console.log('── 2. Copying Core Source Components ────────────────');

function copyRecursiveSync(src, dest) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        fs.readdirSync(src).forEach(childItemName => {
            copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
        });
    } else {
        fs.copyFileSync(src, dest);
    }
}

let copiedCount = 0;
fs.readdirSync(ROOT).forEach(item => {
    if (ALLOWED_COMPONENTS.has(item)) {
        const srcPath = path.join(ROOT, item);
        const destPath = path.join(TEMP_DIR, item);

        try {
            copyRecursiveSync(srcPath, destPath);
            console.log(`  ✅ Added: ${item}`);
            copiedCount++;
        } catch (e) {
            console.error(`  ❌ Failed to copy ${item}: ${e.message}`);
        }
    }
});
console.log(`Copied ${copiedCount} core components successfully.`);

// ── 3. Create the ZIP archive ────────────────────────────────
console.log('\n── 3. Creating Source ZIP Archive ───────────────────');
try {
    if (fs.existsSync(OUT_ZIP)) {
        fs.unlinkSync(OUT_ZIP);
    }

    console.log(`Zipping to ${path.basename(OUT_ZIP)}...`);

    // Use PowerShell's Compress-Archive
    execSync(`powershell -Command "Compress-Archive -Path '${TEMP_DIR}\\*' -DestinationPath '${OUT_ZIP}'"`, {
        cwd: ROOT,
        stdio: 'inherit'
    });

    console.log(`\n🎉 SUCCESS! Clean source code is ready at:`);
    console.log(`   ${OUT_ZIP}`);
} catch (e) {
    console.error(`\n❌ Zipping failed: ${e.message}`);
    process.exit(1);
} finally {
    // ── 4. Cleanup Staging ──────────────────────────────────────
    if (fs.existsSync(TEMP_DIR)) {
        try {
            fs.rmSync(TEMP_DIR, { recursive: true, force: true });
            console.log('Cleaned up staging folder.');
        } catch (e) {
            console.error(`Warning: Failed to remove staging directory: ${e.message}`);
        }
    }
}
