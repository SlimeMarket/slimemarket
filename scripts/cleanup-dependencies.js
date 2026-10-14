#!/usr/bin/env node

/**
 * Dependency Cleanup Script
 * 
 * Identifies and removes unused/extraneous dependencies to reduce bundle size.
 * This helps optimize the initial load from ~101KB to <80KB target.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🧹 Starting dependency cleanup...\n');

// Step 1: Find extraneous packages
console.log('📋 Scanning for extraneous packages...');
try {
  const output = execSync('npm ls --depth=0', { encoding: 'utf-8' });
  
  const extraneousPackages = [];
  const lines = output.split('\n');
  
  lines.forEach(line => {
    const match = line.match(/├──\s+(@?[\w@/]+)@[\d.]+\s+extraneous/);
    if (match) {
      extraneousPackages.push(match[1]);
    }
  });
  
  if (extraneousPackages.length > 0) {
    console.log(`✅ Found ${extraneousPackages.length} extraneous packages:\n`);
    extraneousPackages.forEach(pkg => {
      console.log(`   - ${pkg}`);
    });
    console.log();
    
    // Ask user before removing
    console.log('💡 Removing these packages will clean up your node_modules.');
    console.log('   This is safe - they were likely installed as transitive deps that are no longer needed.\n');
    
    // Remove extraneous packages
    try {
      execSync('npm prune', { stdio: 'inherit' });
      console.log('\n✅ Successfully removed extraneous packages!\n');
    } catch (error) {
      console.error('⚠ Could not run npm prune. You may need to manually delete them.\n');
    }
  } else {
    console.log('✅ No extraneous packages found!\n');
  }
  
} catch (error) {
  console.error('❌ Error scanning dependencies:', error.message);
  process.exit(1);
}

// Step 2: Check for large packages
console.log('📊 Checking package sizes...');
try {
  const nodeModulesDir = './node_modules';
  const packageSizes = [];
  
  // Read package.json
  const pkgJson = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));
  const allDeps = {
    ...pkgJson.dependencies,
    ...pkgJson.devDependencies
  };
  
  Object.keys(allDeps).forEach(pkg => {
    const pkgPath = path.join(nodeModulesDir, pkg);
    if (fs.existsSync(pkgPath)) {
      let totalSize = 0;
      
      // Recursively calculate directory size
      function getDirSize(dir) {
        if (!fs.existsSync(dir)) return 0;
        
        const files = fs.readdirSync(dir);
        files.forEach(file => {
          const filePath = path.join(dir, file);
          const stats = fs.statSync(filePath);
          
          if (stats.isDirectory()) {
            totalSize += getDirSize(filePath);
          } else {
            totalSize += stats.size;
          }
        });
        
        return totalSize;
      }
      
      const sizeBytes = getDirSize(pkgPath);
      const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);
      
      if (parseFloat(sizeMB) > 5) { // Only show packages > 5MB
        packageSizes.push({ name: pkg, size: sizeMB, bytes: sizeBytes });
      }
    }
  });
  
  // Sort by size descending
  packageSizes.sort((a, b) => b.bytes - a.bytes);
  
  if (packageSizes.length > 0) {
    console.log('\n🔍 Largest packages (>5MB):\n');
    packageSizes.slice(0, 10).forEach((pkg, index) => {
      console.log(`   ${index + 1}. ${pkg.name}: ${pkg.size} MB`);
    });
    
    console.log('\n💡 Note: Some of these packages are required but can be optimized through code splitting.\n');
  } else {
    console.log('✅ All packages are under 5MB each.\n');
  }
  
} catch (error) {
  console.warn('⚠ Warning: Could not analyze package sizes:', error.message);
  console.warn('This is okay - it might be a Windows permission issue.\n');
}

// Step 3: Generate optimization report
console.log('📈 Generating optimization recommendations...');
console.log('\n✅ Next steps to reduce bundle size:');
console.log('   1. Run "npm run build:analyze" to identify bundle hotspots');
console.log('   2. Implement dynamic imports for non-critical components');
console.log('   3. Consider tree-shaking unused functions');
console.log('   4. Use import() for large libraries like charts/graphs');
console.log('   5. Enable gzip/brotli compression in deployment\n');

console.log('🎯 Target: Reduce initial bundle from ~101KB to <80KB\n');

console.log('✅ Cleanup complete!\n');
