// popup.js
document.addEventListener('DOMContentLoaded', function() {
  // Get DOM elements
  const tabLinks = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');
  const autoAnalyzeToggle = document.getElementById('autoAnalyzeToggle');
  const analyzeBtn = document.getElementById('analyze-btn');
  const manualAnalyzeBtn = document.getElementById('manual-analyze-btn');
  const domainInfo = document.getElementById('domain-info');
  const riskIndicator = document.getElementById('risk-indicator');
  const riskLevel = document.getElementById('risk-level');
  const summary = document.getElementById('summary');
  const riskFactors = document.getElementById('risk-factors');
  const termsLinks = document.getElementById('terms-links');
  const privacyLinks = document.getElementById('privacy-links');
  const apiKeyInput = document.getElementById('api-key-input');
  const saveApiKeyBtn = document.getElementById('save-api-key');
  const notificationsToggle = document.getElementById('notificationsToggle');
  
  // UI related elements
  const loadingElement = document.getElementById('loading');
  const analysisContent = document.getElementById('analysis-content');
  const noAnalysis = document.getElementById('no-analysis');
  
  // Variables
  let currentTabId = null;
  let currentDomain = '';
  let analysisData = null;
  let policyLinks = null;
  
  // Tab switching
  tabLinks.forEach(tab => {
    tab.addEventListener('click', () => {
      // Remove active class from all tabs
      tabLinks.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      
      // Add active class to clicked tab
      tab.classList.add('active');
      const tabName = tab.getAttribute('data-tab');
      document.getElementById(`${tabName}-tab`).classList.add('active');
    });
  });
  
  // Initialize popup
  init();
  
  function init() {
    // Load saved settings
    loadSettings();
    
    // Get current tab information
    getCurrentTab().then(tab => {
      currentTabId = tab.id;
      currentDomain = extractDomain(tab.url);
      
      // Update domain info
      domainInfo.textContent = `Analyzing: ${currentDomain}`;
      
      // Check if we have analysis data for this tab
      chrome.runtime.sendMessage({
        action: "getTabAnalysis",
        tabId: currentTabId
      }, response => {
        if (chrome.runtime.lastError) {
          console.log("Error getting tab analysis:", chrome.runtime.lastError.message);
          checkPolicyLinks();
          return;
        }
        
        if (response && response.analysis) {
          // We have analysis, display it
          displayAnalysis(response.analysis);
        } else {
          // No analysis yet, check for links
          checkPolicyLinks();
        }
      });
    });
    
    // Set up event listeners
    setupEventListeners();
  }
  
  function getCurrentTab() {
    return new Promise(resolve => {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        resolve(tabs[0]);
      });
    });
  }
  
  function extractDomain(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace('www.', '');
    } catch (e) {
      return url;
    }
  }
  
  function loadSettings() {
    chrome.storage.local.get(['openaiApiKey', 'autoAnalyze', 'showNotifications'], result => {
      // Set API key input
      if (result.openaiApiKey) {
        apiKeyInput.value = result.openaiApiKey;
      }
      
      // Set auto analyze toggle
      if (result.autoAnalyze !== undefined) {
        autoAnalyzeToggle.checked = result.autoAnalyze;
      } else {
        // Default to true
        autoAnalyzeToggle.checked = true;
      }
      
      // Set notifications toggle
      if (result.showNotifications !== undefined) {
        notificationsToggle.checked = result.showNotifications;
      } else {
        // Default to false
        notificationsToggle.checked = false;
      }
    });
  }
  
  function setupEventListeners() {
    // Auto analyze toggle
    autoAnalyzeToggle.addEventListener('change', () => {
      chrome.storage.local.set({ autoAnalyze: autoAnalyzeToggle.checked });
    });
    
    // Notifications toggle
    notificationsToggle.addEventListener('change', () => {
      chrome.storage.local.set({ showNotifications: notificationsToggle.checked });
    });
    
    // Analyze button
    analyzeBtn.addEventListener('click', () => {
      // Show loading UI
      loadingElement.style.display = 'block';
      analysisContent.style.display = 'none';
      noAnalysis.style.display = 'none';
      
      // Trigger manual analysis
      analyzeCurrentPage();
    });
    
    // Manual analyze button
    manualAnalyzeBtn.addEventListener('click', () => {
      // Show loading UI
      loadingElement.style.display = 'block';
      analysisContent.style.display = 'none';
      noAnalysis.style.display = 'none';
      
      // Trigger manual analysis
      analyzeCurrentPage();
    });
    
    // Save API key button
    saveApiKeyBtn.addEventListener('click', () => {
      const apiKey = apiKeyInput.value.trim();
      
      if (apiKey) {
        chrome.storage.local.set({ openaiApiKey: apiKey }, () => {
          // Show success feedback
          saveApiKeyBtn.textContent = 'Saved!';
          setTimeout(() => {
            saveApiKeyBtn.textContent = 'Save';
          }, 2000);
        });
      }
    });
  }
  
  function checkPolicyLinks() {
    // Send message to content script to find policy links
    chrome.tabs.sendMessage(currentTabId, {
      action: "findPolicyLinks"
    }, response => {
      if (chrome.runtime.lastError) {
        console.log("Error finding policy links:", chrome.runtime.lastError.message);
        // Content script might not be injected yet, inject it
        injectContentScript().then(() => {
          // Try again after a short delay
          setTimeout(() => {
            checkPolicyLinks();
          }, 500);
        }).catch(err => {
          // Show error state
          loadingElement.style.display = 'none';
          noAnalysis.style.display = 'block';
        });
        return;
      }
      
      if (response && response.links) {
        // We have links, update UI
        policyLinks = response.links;
        
        // Update links tab content
        updateLinksTab(policyLinks);
        
        // Show appropriate UI
        loadingElement.style.display = 'none';
        
        // Check if we got any links
        if (policyLinks.terms.length > 0 || policyLinks.privacy.length > 0) {
          // We have links, but no analysis yet - this is a loading state
          analysisContent.style.display = 'none';
          noAnalysis.style.display = 'none';
          loadingElement.style.display = 'block';
          
          // Auto analyze if enabled
          chrome.storage.local.get(['autoAnalyze'], result => {
            if (result.autoAnalyze) {
              analyzeCurrentPage();
            } else {
              loadingElement.style.display = 'none';
              noAnalysis.style.display = 'block';
            }
          });
        } else {
          // No links found
          analysisContent.style.display = 'none';
          noAnalysis.style.display = 'block';
        }
      } else {
        // Error or no links found
        loadingElement.style.display = 'none';
        noAnalysis.style.display = 'block';
      }
    });
  }
  
  function injectContentScript() {
    return new Promise((resolve, reject) => {
      chrome.tabs.executeScript(currentTabId, {
        file: 'content.js'
      }, result => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError.message);
        } else {
          resolve(result);
        }
      });
    });
  }
  
  function updateLinksTab(links) {
    // Update terms links
    if (links.terms.length > 0) {
      termsLinks.innerHTML = '';
      
      links.terms.forEach(link => {
        const linkElement = document.createElement('a');
        linkElement.href = link.url;
        linkElement.textContent = link.text || link.url;
        linkElement.target = '_blank';
        termsLinks.appendChild(linkElement);
      });
    } else {
      termsLinks.innerHTML = '<p class="no-links">No Terms of Service links detected.</p>';
    }
    
    // Update privacy links
    if (links.privacy.length > 0) {
      privacyLinks.innerHTML = '';
      
      links.privacy.forEach(link => {
        const linkElement = document.createElement('a');
        linkElement.href = link.url;
        linkElement.textContent = link.text || link.url;
        linkElement.target = '_blank';
        privacyLinks.appendChild(linkElement);
      });
    } else {
      privacyLinks.innerHTML = '<p class="no-links">No Privacy Policy links detected.</p>';
    }
  }
  
  function analyzeCurrentPage() {
    // Send message to content script to extract text
    chrome.tabs.sendMessage(currentTabId, {
      action: "extractTerms"
    }, response => {
      if (chrome.runtime.lastError) {
        console.log("Error extracting terms:", chrome.runtime.lastError.message);
        // Try injecting content script
        injectContentScript().then(() => {
          // Try again after a short delay
          setTimeout(() => {
            analyzeCurrentPage();
          }, 500);
        }).catch(err => {
          // Show error state
          loadingElement.style.display = 'none';
          noAnalysis.style.display = 'block';
        });
        return;
      }
      
      if (response && response.termsText) {
        // Send the text to background script for analysis
        chrome.runtime.sendMessage({
          action: "analyzeContent",
          tabId: currentTabId,
          content: response.termsText,
          url: response.url,
          title: response.title
        }, analysisResponse => {
          if (chrome.runtime.lastError) {
            console.log("Error analyzing content:", chrome.runtime.lastError.message);
            loadingElement.style.display = 'none';
            noAnalysis.style.display = 'block';
            return;
          }
          
          if (analysisResponse && analysisResponse.success) {
            // Background script is handling analysis, we'll check for results soon
            checkAnalysisResults();
          } else {
            // Error or missing API key
            showApiKeyMissing();
          }
        });
      } else {
        // Error extracting content
        loadingElement.style.display = 'none';
        noAnalysis.style.display = 'block';
      }
    });
  }
  
  function checkAnalysisResults() {
    // Poll for analysis results
    const checkInterval = setInterval(() => {
      chrome.runtime.sendMessage({
        action: "getTabAnalysis",
        tabId: currentTabId
      }, response => {
        if (chrome.runtime.lastError) {
          console.log("Error checking analysis results:", chrome.runtime.lastError.message);
          return;
        }
        
        if (response && response.analysis) {
          // We have analysis results, display them
          clearInterval(checkInterval);
          displayAnalysis(response.analysis);
        }
      });
    }, 1000);
    
    // Set a timeout to stop checking after 30 seconds
    setTimeout(() => {
      clearInterval(checkInterval);
      // If we're still showing loading, show an error
      if (loadingElement.style.display !== 'none') {
        loadingElement.style.display = 'none';
        noAnalysis.style.display = 'block';
      }
    }, 30000);
  }
  
  function displayAnalysis(analysis) {
    // Store analysis data
    analysisData = analysis;
    
    // Show analysis content
    loadingElement.style.display = 'none';
    analysisContent.style.display = 'block';
    noAnalysis.style.display = 'none';
    
    // Update risk meter
    const riskScore = analysis.riskScore || 0;
    riskIndicator.style.left = `${riskScore}%`;
    
    // Determine risk level text
    let riskLevelText = '';
    if (riskScore < 33) {
      riskLevelText = 'Low Risk';
    } else if (riskScore < 66) {
      riskLevelText = 'Medium Risk';
    } else {
      riskLevelText = 'High Risk';
    }
    
    riskLevel.textContent = `Risk Level: ${riskLevelText} (${riskScore}/100)`;
    
    // Update summary
    summary.innerHTML = analysis.summary || '<p>No summary available.</p>';
    
    // Update risk factors
    if (analysis.riskFactors && analysis.riskFactors.length > 0) {
      riskFactors.innerHTML = '';
      
      analysis.riskFactors.forEach(factor => {
        const factorElement = document.createElement('div');
        factorElement.className = `risk-item ${factor.level}-risk`;
        
        const factorTitle = document.createElement('h4');
        factorTitle.textContent = factor.title;
        factorTitle.style.margin = '0 0 5px 0';
        
        const factorDesc = document.createElement('p');
        factorDesc.textContent = factor.description;
        factorDesc.style.margin = '0';
        
        factorElement.appendChild(factorTitle);
        factorElement.appendChild(factorDesc);
        riskFactors.appendChild(factorElement);
      });
    } else {
      riskFactors.innerHTML = '<p>No specific risk factors identified.</p>';
    }
  }
  
  function showApiKeyMissing() {
    // Show an error about missing API key
    loadingElement.style.display = 'none';
    noAnalysis.style.display = 'block';
    
    // Switch to settings tab
    tabLinks.forEach(t => t.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));
    
    const settingsTab = document.querySelector('.tab[data-tab="settings"]');
    settingsTab.classList.add('active');
    document.getElementById('settings-tab').classList.add('active');
  }
  
  // Message listener for background script updates
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "analysisComplete" && message.tabId === currentTabId) {
      if (message.analysis) {
        displayAnalysis(message.analysis);
      }
    }
    return true;
  });
});