// content.js
// Enhanced content script that detects, fetches and analyzes terms automatically
(() => {
    // Terms & privacy policy link detection patterns
    const TERMS_PATTERNS = [
      /terms\s+of\s+(use|service)/i, 
      /terms\s+and\s+conditions/i, 
      /user\s+agreement/i,
      /legal/i
    ];
    
    const PRIVACY_PATTERNS = [
      /privacy\s+policy/i,
      /data\s+policy/i,
      /data\s+protection/i
    ];
    
    // Store discovered links
    let discoveredLinks = {
      terms: [],
      privacy: []
    };
    
    // Listen for requests from popup
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === "extractTerms") {
        // Direct extraction mode (like the original)
        let termsText = extractTermsContent();
        
        // If extraction yielded insufficient content, get general page content
        if (!termsText || termsText.length < 500) {
          termsText = document.body.innerText || "";
          
          // Add URL to help API understand context
          const currentUrl = window.location.href;
          termsText = "URL: " + currentUrl + "\n\n" + termsText;
        }
        
        // Send response back to popup
        sendResponse({
          termsText: termsText,
          url: window.location.href,
          title: document.title || "Unknown Page"
        });
      } else if (request.action === "findPolicyLinks") {
        // Auto detection mode
        detectPolicyLinks();
        sendResponse({
          links: discoveredLinks,
          url: window.location.href,
          title: document.title || "Unknown Page" 
        });
      } else if (request.action === "pageInfo") {
        sendResponse({
          url: window.location.href,
          title: document.title || "Unknown Page",
          domain: extractDomain(window.location.href)
        });
      }
      return true;  // Required for async response
    });
    
    // Extract domain from URL
    function extractDomain(url) {
      try {
        const urlObj = new URL(url);
        return urlObj.hostname.replace('www.', '');
      } catch (e) {
        return url;
      }
    }
    
    // Find all links that could be terms or privacy policies
    function detectPolicyLinks() {
      discoveredLinks = {
        terms: [],
        privacy: []
      };
      
      // Get all anchor elements
      const links = document.querySelectorAll('a');
      
      links.forEach(link => {
        const href = link.getAttribute('href');
        const text = link.textContent.trim();
        
        if (!href) return;
        
        // Convert relative URLs to absolute
        const absoluteUrl = new URL(href, window.location.origin).href;
        
        // Check if link text matches any terms patterns
        if (TERMS_PATTERNS.some(pattern => pattern.test(text))) {
          discoveredLinks.terms.push({
            url: absoluteUrl,
            text: text
          });
        }
        
        // Check if link text matches any privacy patterns
        if (PRIVACY_PATTERNS.some(pattern => pattern.test(text))) {
          discoveredLinks.privacy.push({
            url: absoluteUrl,
            text: text
          });
        }
        
        // Also check href itself for patterns
        if (TERMS_PATTERNS.some(pattern => pattern.test(href)) && 
            !discoveredLinks.terms.some(item => item.url === absoluteUrl)) {
          discoveredLinks.terms.push({
            url: absoluteUrl,
            text: text || href
          });
        }
        
        if (PRIVACY_PATTERNS.some(pattern => pattern.test(href)) && 
            !discoveredLinks.privacy.some(item => item.url === absoluteUrl)) {
          discoveredLinks.privacy.push({
            url: absoluteUrl,
            text: text || href
          });
        }
      });
      
      // Deduplicate links
      discoveredLinks.terms = [...new Map(discoveredLinks.terms.map(item => 
        [item.url, item])).values()];
      discoveredLinks.privacy = [...new Map(discoveredLinks.privacy.map(item => 
        [item.url, item])).values()];
        
      // Send discovered links to background script
      chrome.runtime.sendMessage({
        action: "policyLinksFound",
        links: discoveredLinks
      });
    }
    
    // Enhanced extraction function that tries multiple strategies
    function extractTermsContent() {
      // Try specific element targeting first
      const termsSelectorOptions = [
        // Common IDs for terms sections
        '#terms', '#terms-of-service', '#terms-conditions', '#privacy-policy', '#privacy', '#tos',
        '#legal', '#conditions', '#eula', '#agreement', '#cookie-policy',
        
        // Common classes
        '.terms', '.terms-of-service', '.privacy-policy', '.legal', '.conditions',
        '.terms-content', '.privacy-content', '.legal-content', '.policy-content',
        
        // More generic content containers that often hold terms
        'main', 'article', '.content', '.main-content', '#content', '#main-content',
        '.page-content', '#page-content', '.container', '.main-container'
      ];
    
      for (const selector of termsSelectorOptions) {
        const element = document.querySelector(selector);
        if (element && element.innerText && element.innerText.length > 500) {
          return element.innerText;
        }
      }
    
      // Try finding content after relevant headings
      const headingContent = findContentAfterRelevantHeadings();
      if (headingContent && headingContent.length > 500) {
        return headingContent;
      }
    
      // Last resort - try to get any significant text blocks
      return findLargestTextBlocks();
    }
    
    // Find content after headings related to terms/privacy
    function findContentAfterRelevantHeadings() {
      const relevantHeadingTexts = [
        'terms', 'conditions', 'service', 'terms of service', 
        'terms and conditions', 'privacy', 'privacy policy',
        'legal', 'agreement', 'user agreement', 'terms of use'
      ];
      
      const headings = document.querySelectorAll('h1, h2, h3, h4, strong, b');
      let combinedContent = '';
      
      for (const heading of headings) {
        const headingText = heading.innerText.toLowerCase();
        
        // Check if heading contains any relevant terms
        const isRelevantHeading = relevantHeadingTexts.some(term => 
          headingText.includes(term));
        
        if (isRelevantHeading) {
          // Get next sibling content
          let currentNode = heading.nextElementSibling;
          let sectionContent = '';
          
          // Collect content until the next heading or 5 elements
          let elementCount = 0;
          while (currentNode && elementCount < 10) {
            // Stop if we hit another heading
            if (currentNode.tagName && ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(currentNode.tagName)) {
              break;
            }
            
            if (currentNode.innerText && currentNode.innerText.trim()) {
              sectionContent += currentNode.innerText + '\n\n';
            }
            
            currentNode = currentNode.nextElementSibling;
            elementCount++;
          }
          
          // If meaningful content found, add it with the heading
          if (sectionContent.length > 200) {
            combinedContent += heading.innerText + '\n\n' + sectionContent + '\n\n';
          }
        }
      }
      
      return combinedContent;
    }
    
    // Find large text blocks as a fallback
    function findLargestTextBlocks() {
      const paragraphs = document.querySelectorAll('p, div, section, article');
      const textBlocks = [];
      
      // Collect all text blocks with substantial content
      paragraphs.forEach(element => {
        const text = element.innerText;
        if (text && text.length > 100) {
          textBlocks.push({
            element,
            text,
            length: text.length
          });
        }
      });
      
      // Sort by size (largest first)
      textBlocks.sort((a, b) => b.length - a.length);
      
      // Take top largest blocks (up to 10)
      let combinedText = '';
      const topBlocks = textBlocks.slice(0, 10);
      
      for (const block of topBlocks) {
        combinedText += block.text + '\n\n';
        
        // Stop if we have enough text
        if (combinedText.length > 5000) {
          break;
        }
      }
      
      return combinedText;
    }
    
    // Run automatic detection when page loads
    window.addEventListener('load', () => {
      // Wait a moment for page to stabilize
      setTimeout(() => {
        detectPolicyLinks();
      }, 1000);
    });
  })();