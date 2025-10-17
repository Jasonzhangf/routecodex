#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const crypto = require('crypto');

// Configuration
const BINARY_NAME = 'qodercli';
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(PACKAGE_ROOT, 'bin');
const PACKAGE_JSON_PATH = path.join(PACKAGE_ROOT, 'package.json');

class QoderInstaller {
  constructor() {
    this.platform = this.detectPlatform();
    this.arch = this.detectArch();
    this.binPath = path.join(BIN_DIR, BINARY_NAME + (process.platform === 'win32' ? '.exe' : ''));
    this.packageInfo = this.loadPackageInfo();
  }

  detectPlatform() {
    switch (process.platform) {
      case 'darwin': return 'darwin';
      case 'linux': return 'linux';
      case 'win32': return 'windows';
      default:
        throw new Error(`Unsupported platform: ${process.platform}`);
    }
  }

  detectArch() {
    const arch = process.arch;
    switch (arch) {
      case 'x64': return 'amd64';
      case 'arm64': return 'arm64';
      default:
        throw new Error(`Unsupported architecture: ${arch}`);
    }
  }

  loadPackageInfo() {
    try {
      const packageJson = fs.readFileSync(PACKAGE_JSON_PATH, 'utf8');
      const packageInfo = JSON.parse(packageJson);
      
      if (!packageInfo.binaries || !packageInfo.binaries.files) {
        throw new Error('Binary information missing in package configuration');
      }
      
      return packageInfo;
    } catch (error) {
      throw new Error(`Unable to read package configuration: ${error.message}`);
    }
  }

  findBinaryInfo() {
    const files = this.packageInfo.binaries.files;
    const targetFile = files.find(file => 
      file.os === this.platform && file.arch === this.arch
    );

    if (!targetFile) {
      throw new Error(`Unsupported platform: ${this.platform}/${this.arch}`);
    }

    return targetFile;
  }

  async downloadBinary(url, expectedSha256) {
    console.log(`Downloading binary: ${url}`);
    
    // Create temporary directory for download operations
    const os = require('os');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercli-install-'));
    
    // Ensure target directory exists
    if (!fs.existsSync(BIN_DIR)) {
      fs.mkdirSync(BIN_DIR, { recursive: true });
    }

    // Download file to temporary directory
    const filename = path.basename(url);
    const archivePath = path.join(tempDir, filename);
    
    try {
      await this.downloadFile(url, archivePath);
      
      // Verify checksum
      console.log('Verifying file integrity...');
      const actualSha256 = this.calculateSha256(archivePath);
      if (actualSha256 !== expectedSha256) {
        throw new Error(`Checksum mismatch. Expected: ${expectedSha256}, Got: ${actualSha256}`);
      }
      
      // Extract file to temporary directory first
      console.log('Extracting binary...');
      const extractDir = path.join(tempDir, 'extract');
      fs.mkdirSync(extractDir, { recursive: true });
      await this.extractArchive(archivePath, filename, extractDir);
      
      // Move extracted binary to final destination
      const extractedBinary = this.findExtractedBinary(extractDir);
      if (extractedBinary.length === 0) {
        throw new Error(`Binary file not found after extraction in ${extractDir}`);
      }
      
      // Try rename first (efficient), fallback to copy+delete if cross-device
      try {
        fs.renameSync(extractedBinary[0], this.binPath);
      } catch (error) {
        if (error.code === 'EXDEV') {
          // Cross-device link not permitted, use copy+delete fallback
          console.log('Cross-device link detected, using copy+delete method...');
          fs.copyFileSync(extractedBinary[0], this.binPath);
          fs.unlinkSync(extractedBinary[0]);
        } else {
          throw error;
        }
      }
      
      // Set executable permission
      if (process.platform !== 'win32') {
        fs.chmodSync(this.binPath, 0o755);
      }
      
      // Create installation source marker
      const sourceFile = path.join(BIN_DIR, '.qodercli-install-resource');
      fs.writeFileSync(sourceFile, 'npm', 'utf8');
      
      // Verify installation
      this.verifyInstallation();
      
    } catch (error) {
      throw error;
    } finally {
      // Always cleanup temporary directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn('Warning: Failed to cleanup temporary directory:', cleanupError.message);
      }
    }
  }

  async extractArchive(archivePath, filename, extractDir) {
    if (filename.endsWith('.zip')) {
      // Extract ZIP file using Node.js packages first
      let extracted = false;
      
      // Method 1: Use adm-zip package (preferred)
      try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(archivePath);
        zip.extractAllTo(extractDir, true);
        extracted = true;
        console.log('ZIP extracted using Node.js adm-zip package');
      } catch (error) {
        console.log('adm-zip extraction failed, trying system commands...', error.message);
      }
      
      // Method 2: System command fallbacks
      if (!extracted) {
        if (process.platform === 'win32') {
          // Windows: Try PowerShell then 7-Zip
          try {
            execSync(`powershell -command "Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force"`, {
              stdio: 'pipe'
            });
            extracted = true;
          } catch (error) {
            try {
              execSync(`7z x "${archivePath}" -o"${extractDir}" -y`, {
                stdio: 'pipe'
              });
              extracted = true;
            } catch (error2) {
              // Will fail below
            }
          }
        } else {
          // Unix: Use unzip command
          try {
            execSync(`unzip -o "${archivePath}" -d "${extractDir}"`, {
              stdio: 'pipe'
            });
            extracted = true;
          } catch (error) {
            // Will fail below
          }
        }
      }
      
      if (!extracted) {
        const platform = process.platform === 'win32' ? 'Windows' : 'Unix';
        throw new Error(`ZIP extraction failed on ${platform}. Please ensure extraction tools are available.`);
      }
    } else {
      // Extract tar.gz file using Node.js tar package first
      let extracted = false;
      
      // Method 1: Use tar package (preferred)
      try {
        const tar = require('tar');
        // tar v4.x uses different API than v6.x
        await tar.extract({
          file: archivePath,
          cwd: extractDir
        });
        extracted = true;
        console.log('tar.gz extracted using Node.js tar package');
      } catch (error) {
        console.log('Node.js tar extraction failed, trying system tar command...', error.message);
      }
      
      // Method 2: System tar command fallback
      if (!extracted) {
        try {
          execSync(`tar -xzf "${archivePath}" -C "${extractDir}"`, {
            stdio: 'pipe'
          });
          extracted = true;
        } catch (error) {
          throw new Error('tar.gz extraction failed. Please ensure tar command is installed.');
        }
      }
    }
  }


  calculateSha256(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(fileBuffer);
    return hashSum.digest('hex');
  }

  findExtractedBinary(searchDir) {
    const results = [];
    const expectedFilename = BINARY_NAME + (process.platform === 'win32' ? '.exe' : '');
    
    try {
      const items = fs.readdirSync(searchDir, { withFileTypes: true });
      
      for (const item of items) {
        const fullPath = path.join(searchDir, item.name);
        
        if (item.isDirectory()) {
          // Recursively search in subdirectories
          results.push(...this.findExtractedBinary(fullPath));
        } else if (item.name === expectedFilename) {
          results.push(fullPath);
        }
      }
    } catch (error) {
      console.warn(`Unable to search directory ${searchDir}:`, error.message);
    }
    
    return results;
  }

  verifyInstallation() {
    if (!fs.existsSync(this.binPath)) {
      throw new Error('Binary installation failed');
    }

    try {
      // Try to run version command for verification
      const output = execSync(`"${this.binPath}" --version`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
      console.log('Installation verified successfully');
      console.log(`Version info: ${output.trim()}`);
    } catch (error) {
      console.warn('Warning: Unable to verify installation, but binary file exists');
    }
  }

  async downloadFile(url, filePath, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      const client = url.startsWith('https:') ? https : http;
      let cleanupDone = false;
      
      const cleanup = () => {
        if (cleanupDone) return;
        cleanupDone = true;
        
        try {
          file.close();
        } catch (e) {
          // Ignore errors during cleanup
        }
        
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (e) {
          // Ignore errors during cleanup
        }
      };
      
      const request = client.get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // Handle redirect
          cleanup();
          return this.downloadFile(response.headers.location, filePath, timeout)
            .then(resolve).catch(reject);
        }
        
        if (response.statusCode !== 200) {
          cleanup();
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
          return;
        }

        response.pipe(file);
        
        file.on('finish', () => {
          if (!cleanupDone) {
            file.close();
            resolve();
          }
        });
        
        file.on('error', (error) => {
          cleanup();
          reject(error);
        });
      }).on('error', (error) => {
        cleanup();
        reject(error);
      });

      // Set timeout
      request.setTimeout(timeout, () => {
        request.destroy();
        cleanup();
        reject(new Error(`Download timeout (${timeout}ms): ${url}`));
      });
      
      // Handle process interruption signals
      const handleSignal = () => {
        request.destroy();
        cleanup();
        reject(new Error('Download interrupted by signal'));
      };
      
      process.once('SIGINT', handleSignal);
      process.once('SIGTERM', handleSignal);
      
      // Clean up signal handlers when promise resolves/rejects
      const originalResolve = resolve;
      const originalReject = reject;
      
      resolve = (...args) => {
        process.removeListener('SIGINT', handleSignal);
        process.removeListener('SIGTERM', handleSignal);
        originalResolve(...args);
      };
      
      reject = (...args) => {
        process.removeListener('SIGINT', handleSignal);
        process.removeListener('SIGTERM', handleSignal);
        originalReject(...args);
      };
    });
  }

  async install() {
    try {
      console.log('Installing Qoder CLI...');
      console.log(`Target platform: ${this.platform}/${this.arch}`);
      console.log(`Version: ${this.packageInfo.binaries.version}`);
      
      // If already installed, reinstall
      if (fs.existsSync(this.binPath)) {
        console.log('Existing version detected, will reinstall');
      }

      const binaryInfo = this.findBinaryInfo();
      await this.downloadBinary(binaryInfo.url, binaryInfo.sha256);
      
      console.log('✅ Qoder CLI installed successfully!');
      console.log(`Run 'npx qodercli --help' to get started`);
      
    } catch (error) {
      console.error('❌ Installation failed:', error.message);
      process.exit(1);
    }
  }
}

// Main program
if (require.main === module) {
  try {
    const installer = new QoderInstaller();
    installer.install();
  } catch (error) {
    console.error('❌ Failed to initialize installer:', error.message);
    console.error('This might be due to Node.js version compatibility issues.');
    console.error(`Current Node.js version: ${process.version}`);
    console.error('Required Node.js version: >=14');
    process.exit(1);
  }
}

module.exports = QoderInstaller;