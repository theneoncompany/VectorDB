class VectorKnowledgeBase {
  constructor() {
    this.files = [];
    this.apiKey = 'wjiduihy8gf2ty9hbh2e8vr2yf9evfueb2y9bf9ih9cvmbsbdnc9efhi'; // Replace with your API key
    this.baseUrl = window.location.origin;
    this.init();
  }

  init() {
    this.setupEventListeners();
    this.checkServerStatus();
    setInterval(() => this.checkServerStatus(), 30000); // Check every 30 seconds
  }

  setupEventListeners() {
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const uploadBtn = document.getElementById('uploadBtn');
    const processBtn = document.getElementById('processBtn');
    const searchBtn = document.getElementById('searchBtn');
    const searchInput = document.getElementById('searchInput');
    const testSheetsBtn = document.getElementById('testSheetsBtn');
    const syncSheetsBtn = document.getElementById('syncSheetsBtn');

    // Upload area events
    uploadArea.addEventListener('click', () => fileInput.click());
    uploadArea.addEventListener('dragover', this.handleDragOver.bind(this));
    uploadArea.addEventListener('dragleave', this.handleDragLeave.bind(this));
    uploadArea.addEventListener('drop', this.handleDrop.bind(this));

    // File input change
    fileInput.addEventListener('change', (e) => this.handleFiles(e.target.files));

    // Upload button
    uploadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });

    // Process button
    processBtn.addEventListener('click', this.processAllFiles.bind(this));

    // Search functionality
    searchBtn.addEventListener('click', this.performSearch.bind(this));
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.performSearch();
    });

    // Google Sheets sync events
    testSheetsBtn.addEventListener('click', this.testSheetsConnection.bind(this));
    syncSheetsBtn.addEventListener('click', this.syncGoogleSheets.bind(this));
  }

  async checkServerStatus() {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');

    try {
      const response = await fetch(`${this.baseUrl}/health`);
      const data = await response.json();

      if (data.success) {
        statusDot.className = 'status-dot connected';
        statusText.textContent = 'Connected';
      } else {
        statusDot.className = 'status-dot error';
        statusText.textContent = 'Service Error';
      }
    } catch (error) {
      statusDot.className = 'status-dot error';
      statusText.textContent = 'Disconnected';
    }
  }

  handleDragOver(e) {
    e.preventDefault();
    e.currentTarget.classList.add('dragover');
  }

  handleDragLeave(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('dragover');
  }

  handleDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('dragover');
    this.handleFiles(e.dataTransfer.files);
  }

  handleFiles(fileList) {
    const newFiles = Array.from(fileList).map((file) => ({
      id: Date.now() + Math.random(),
      file,
      name: file.name,
      size: file.size,
      type: this.getFileType(file.name),
      status: 'pending',
    }));

    this.files.push(...newFiles);
    this.renderFilesList();
    this.updateProcessButton();
  }

  getFileType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    return ext;
  }

  getFileIcon(type) {
    const icons = {
      pdf: 'fas fa-file-pdf',
      csv: 'fas fa-file-csv',
      txt: 'fas fa-file-alt',
      docx: 'fas fa-file-word',
      md: 'fas fa-file-code',
    };
    return icons[type] || 'fas fa-file';
  }

  formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  renderFilesList() {
    const filesList = document.getElementById('filesList');

    if (this.files.length === 0) {
      filesList.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-inbox"></i>
                    <p>No files selected yet</p>
                </div>
            `;
      return;
    }

    filesList.innerHTML = this.files
      .map(
        (file) => `
            <div class="file-item">
                <div class="file-info">
                    <div class="file-icon ${file.type}">
                        <i class="${this.getFileIcon(file.type)}"></i>
                    </div>
                    <div class="file-details">
                        <h4>${file.name}</h4>
                        <p>${this.formatFileSize(file.size)}</p>
                    </div>
                </div>
                <div class="file-status ${file.status}">${file.status}</div>
            </div>
        `
      )
      .join('');
  }

  updateProcessButton() {
    const processBtn = document.getElementById('processBtn');
    const pendingFiles = this.files.filter((f) => f.status === 'pending');

    processBtn.disabled = pendingFiles.length === 0;
    processBtn.innerHTML = `
            <i class="fas fa-play"></i> 
            Process ${pendingFiles.length} File${pendingFiles.length !== 1 ? 's' : ''}
        `;
  }

  async processAllFiles() {
    const pendingFiles = this.files.filter((f) => f.status === 'pending');
    if (pendingFiles.length === 0) return;

    this.showProgressModal();

    let processed = 0;
    let totalChunks = 0;
    let totalTokens = 0;
    const startTime = Date.now();

    for (const fileObj of pendingFiles) {
      try {
        this.updateProgress(processed, pendingFiles.length, `Processing ${fileObj.name}...`);
        fileObj.status = 'processing';
        this.renderFilesList();

        const content = await this.extractFileContent(fileObj.file);
        const result = await this.embedAndStore(content, fileObj.name);

        if (result.success) {
          fileObj.status = 'success';
          totalChunks += result.data.totalChunks;
          totalTokens += result.data.totalTokens;
          this.logResult(
            'success',
            `✓ ${fileObj.name}: ${result.data.totalChunks} chunks, ${result.data.totalTokens} tokens`
          );
        } else {
          fileObj.status = 'error';
          this.logResult('error', `✗ ${fileObj.name}: ${result.error}`);
        }
      } catch (error) {
        fileObj.status = 'error';
        this.logResult('error', `✗ ${fileObj.name}: ${error.message}`);
      }

      processed++;
      this.renderFilesList();
    }

    const processingTime = Math.round((Date.now() - startTime) / 1000);
    this.updateStats(processed, totalChunks, totalTokens, processingTime);
    this.hideProgressModal();
    this.updateProcessButton();
  }

  async extractFileContent(file) {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${this.baseUrl}/api/extract-content`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Failed to extract content: ${response.statusText}`);
    }

    const result = await response.json();
    return result.content;
  }

  async embedAndStore(content, filename) {
    const chunkSize = parseInt(document.getElementById('chunkSize').value);
    const overlap = parseInt(document.getElementById('overlap').value);
    const preserveSentences = document.getElementById('preserveSentences').checked;

    const response = await fetch(`${this.baseUrl}/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        text: content,
        docId: filename,
        chunkSize,
        overlap,
        preserveSentences,
      }),
    });

    return await response.json();
  }

  async performSearch() {
    const searchInput = document.getElementById('searchInput');
    const searchResults = document.getElementById('searchResults');
    const query = searchInput.value.trim();

    if (!query) return;

    searchResults.innerHTML = '<div class="loading">Searching...</div>';

    try {
      const response = await fetch(`${this.baseUrl}/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          text: query,
          topK: 5,
          fetchPayload: true,
        }),
      });

      const result = await response.json();

      if (result.success && result.data.results.length > 0) {
        searchResults.innerHTML = result.data.results
          .map(
            (item) => `
                    <div class="search-result">
                        <div class="result-score">Score: ${item.score.toFixed(3)}</div>
                        <div class="result-text">${item.payload?.text || 'No text available'}</div>
                        ${item.payload?.docId ? `<div class="result-source">Source: ${item.payload.docId}</div>` : ''}
                    </div>
                `
          )
          .join('');
      } else {
        searchResults.innerHTML = '<div class="empty-state"><p>No results found</p></div>';
      }
    } catch (error) {
      searchResults.innerHTML = `<div class="error">Search failed: ${error.message}</div>`;
    }
  }

  showProgressModal() {
    document.getElementById('progressModal').classList.add('show');
  }

  hideProgressModal() {
    document.getElementById('progressModal').classList.remove('show');
  }

  updateProgress(current, total, text) {
    const progress = (current / total) * 100;
    document.getElementById('progressFill').style.width = `${progress}%`;
    document.getElementById('progressText').textContent = text;
  }

  logResult(type, message) {
    const log = document.getElementById('resultsLog');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
  }

  updateStats(files, chunks, tokens, time) {
    document.getElementById('totalFiles').textContent = files;
    document.getElementById('totalChunks').textContent = chunks;
    document.getElementById('totalTokens').textContent = tokens.toLocaleString();
    document.getElementById('processingTime').textContent = `${time}s`;
  }

  async testSheetsConnection() {
    const spreadsheetId = document.getElementById('spreadsheetId').value;
    const syncStatus = document.getElementById('syncStatus');
    const testBtn = document.getElementById('testSheetsBtn');

    if (!spreadsheetId) {
      this.showSyncStatus('error', 'Please enter a Spreadsheet ID');
      return;
    }

    testBtn.disabled = true;
    testBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing...';

    try {
      const response = await fetch(`${this.baseUrl}/sync/sheets/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ spreadsheetId }),
      });

      const result = await response.json();

      if (result.success && result.data.connected) {
        this.showSyncStatus('success', '✓ Connected to Google Sheets successfully!');

        // Load available sheets
        await this.loadAvailableSheets(spreadsheetId);
      } else {
        this.showSyncStatus('error', '✗ Failed to connect to Google Sheets');
      }
    } catch (error) {
      this.showSyncStatus('error', `✗ Connection failed: ${error.message}`);
    } finally {
      testBtn.disabled = false;
      testBtn.innerHTML = '<i class="fas fa-link"></i> Test Connection';
    }
  }

  async loadAvailableSheets(spreadsheetId) {
    try {
      const response = await fetch(
        `${this.baseUrl}/sync/sheets/list?spreadsheetId=${spreadsheetId}`,
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        }
      );

      const result = await response.json();
      console.log('Sheet list result:', result);

      if (result.success) {
        const sheetSelect = document.getElementById('sheetName');
        const sheets = result.data.sheets;

        console.log('Found sheets:', sheets);
        console.log('Sheet select element:', sheetSelect);

        // Clear existing options
        sheetSelect.innerHTML = '';

        // Add sheets as options
        sheets.forEach((sheetName) => {
          const option = document.createElement('option');
          option.value = sheetName;
          option.textContent = sheetName;
          sheetSelect.appendChild(option);
          console.log('Added option:', sheetName);
        });

        // Set default to "Algemene vragen" if available
        if (sheets.includes('Algemene vragen')) {
          sheetSelect.value = 'Algemene vragen';
        }

        this.showSyncStatus('info', `Found ${sheets.length} sheets: ${sheets.join(', ')}`);
      }
    } catch (error) {
      console.error('Failed to load sheets:', error);
    }
  }

  async syncGoogleSheets() {
    const spreadsheetId = document.getElementById('spreadsheetId').value;
    const sheetName = document.getElementById('sheetName').value;
    const syncBtn = document.getElementById('syncSheetsBtn');

    if (!spreadsheetId || !sheetName) {
      this.showSyncStatus('error', 'Please enter Spreadsheet ID and Sheet Name');
      return;
    }

    syncBtn.disabled = true;
    syncBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing...';

    try {
      this.showSyncStatus('info', 'Starting Google Sheets sync...');

      const response = await fetch(`${this.baseUrl}/sync/sheets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          spreadsheetId,
          sheetName,
          keyColumn: 'question', // Use the question as the unique identifier
          textColumns: ['question', 'Answer'], // The two columns we have
          metadataColumns: [], // No additional metadata columns for now
        }),
      });

      const result = await response.json();

      if (result.success) {
        const stats = result.data.stats;
        this.showSyncStatus(
          'success',
          `✓ Sync completed! Processed ${stats.processedRows}/${stats.totalRows} rows ` +
            `(${stats.errors} errors) in ${Math.round(stats.processingTimeMs / 1000)}s`
        );

        // Update the processing stats
        this.updateStats(
          stats.processedRows,
          stats.newChunks + stats.updatedChunks,
          stats.processedRows * 100, // Estimate tokens
          Math.round(stats.processingTimeMs / 1000)
        );
      } else {
        this.showSyncStatus('error', `✗ Sync failed: ${result.error}`);
      }
    } catch (error) {
      this.showSyncStatus('error', `✗ Sync failed: ${error.message}`);
    } finally {
      syncBtn.disabled = false;
      syncBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Sync Now';
    }
  }

  showSyncStatus(type, message) {
    const syncStatus = document.getElementById('syncStatus');
    const className =
      type === 'success' ? 'sync-success' : type === 'error' ? 'sync-error' : 'sync-info';

    syncStatus.className = `sync-status ${className}`;
    syncStatus.textContent = message;
    syncStatus.style.display = 'block';

    // Auto-hide info messages after 5 seconds
    if (type === 'info') {
      setTimeout(() => {
        syncStatus.style.display = 'none';
      }, 5000);
    }
  }
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
  new VectorKnowledgeBase();
});
