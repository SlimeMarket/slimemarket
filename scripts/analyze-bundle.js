#!/usr/bin/env node

/**
 * Bundle Analyzer Script
 * 
 * Analyzes Next.js webpack bundle to identify optimization opportunities.
 * Generates interactive HTML report showing bundle composition and sizes.
 * 
 * Usage: npm run build:analyze
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ANSI_COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

console.log(`${ANSI_COLORS.cyan}📊 Starting Bundle Analysis...${ANSI_COLORS.reset}\n`);

// Step 1: Clean previous build artifacts
console.log(`${ANSI_COLORS.blue}🧹 Cleaning previous build artifacts...${ANSI_COLORS.reset}`);
try {
  const buildDir = '.next';
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
    console.log(`   ✓ Removed ${buildDir}/ directory\n`);
  }
} catch (error) {
  console.error(`   ⚠ Warning: Could not clean .next directory: ${error.message}\n`);
}

// Step 2: Build with stats generation
console.log(`${ANSI_COLORS.blue}🔨 Building application with bundle analysis...${ANSI_COLORS.reset}`);
console.log(`   This may take a few minutes...\n`);

const envWithAnalyzer = {
  ...process.env,
  BUNDLE_ANALYZE: 'true',
};

try {
  // Run next build with analyzer
  execSync('npm run build', { 
    stdio: 'inherit',
    env: envWithAnalyzer
  });
  
  console.log(`\n${ANSI_COLORS.green}✓ Build completed successfully!${ANSI_COLORS.reset}\n`);
  
  // Step 3: Locate and open the bundle analyzer report
  const reportPath = path.join(process.cwd(), '.next', 'analyze-bundle-report.html');
  
  if (fs.existsSync(reportPath)) {
    console.log(`${ANSI_COLORS.green}✓ Bundle analysis report generated:${ANSI_COLORS.reset}`);
    console.log(`   Path: ${reportPath}`);
    
    // Check if file size indicates successful report
    const stats = fs.statSync(reportPath);
    console.log(`   Size: ${(stats.size / 1024).toFixed(2)} KB\n`);
    
    console.log(`${ANSI_COLORS.yellow}💡 Next steps:${ANSI_COLORS.reset}`);
    console.log(`   1. Open the HTML file in your browser to view interactive chart`);
    console.log(`   2. Look for large chunks and consider code splitting`);
    console.log(`   3. Identify unused imports and remove them`);
    console.log(`   4. Check for duplicate dependencies\n`);
    
  } else {
    // Fallback: Look for analyze folder
    const analyzeFolder = path.join(process.cwd(), '.next', 'analyze-server');
    if (fs.existsSync(analyzeFolder)) {
      const files = fs.readdirSync(analyzeFolder);
      console.log(`${ANSI_COLORS.yellow}⚠ Reports found in analyze folder:${ANSI_COLORS.reset}`);
      files.forEach(file => {
        console.log(`   - ${file}`);
      });
    }
  }
  
} catch (error) {
  console.error(`\n${ANSI_COLORS.red}✗ Bundle analysis failed:${ANSI_COLORS.reset}`);
  console.error(`   Error: ${error.message}`);
  console.error(`\nTroubleshooting:`);
  console.error(`   1. Ensure all dependencies are installed: npm install`);
  console.error(`   2. Check webpack-bundle-analyzer is in devDependencies`);
  console.error(`   3. Try building manually: npm run build`);
  
  process.exit(1);
}

console.log(`${ANSI_COLORS.green}✅ Analysis complete!\n${ANSI_COLORS.reset}`);
