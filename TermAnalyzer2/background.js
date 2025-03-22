// background.js
// Background script that handles fetching and analyzing policies automatically
let activeTabId = null;
let policyCache = {};
let analysisCache = {};
let domainToTabId = {}; // Map domains to tab IDs for cross-reference
let fetchTimeouts = {}; // Track fetch timeouts to prevent hanging

// Keep track of the active tab
chrome.tabs.onActivated.addListener((activeInfo) => {
  activeTabId = activeInfo.tabId;

  // Update icon to indicate when analysis is available
  updateBadge(activeTabId);
});

// Monitor tab updates to catch navigation events
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    tab.url &&
    tab.url.startsWith("http")
  ) {
    const domain = extractDomain(tab.url);
    domainToTabId[domain] = tabId;

    // Check if auto-analyze is enabled
    chrome.storage.local.get(["autoAnalyze"], (result) => {
      const autoAnalyze =
        result.autoAnalyze !== undefined ? result.autoAnalyze : true;

      if (!autoAnalyze) {
        // If auto-analyze is disabled, just clear the badge
        chrome.action.setBadgeText({ text: "", tabId });
        return;
      }

      // Check if we already have analysis for this domain
      if (analysisCache[tabId] && analysisCache[tabId].domain === domain) {
        // Analysis exists, update the badge
        updateBadge(tabId);
      } else {
        // No analysis yet, initiate policy discovery
        // Around line 39, replace the try-catch block with:
        setTimeout(() => {
          chrome.tabs.sendMessage(
            tabId,
            { action: "discoverPolicies" },
            (response) => {
              if (chrome.runtime.lastError) {
                console.log(
                  "Content script not ready, using direct search instead:",
                  chrome.runtime.lastError
                );
                searchPolicyLinks(domain, tabId);
                return;
              }

              if (!response || !response.success) {
                searchPolicyLinks(domain, tabId);
              }
            }
          );
        }, 500); // Give content script time to load
      }
    });
  }
});

// Listen for policy links found in content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "policyLinksFound") {
    const tabId = sender.tab.id;

    // Store links for this tab
    if (!policyCache[tabId]) {
      policyCache[tabId] = {};
    }

    policyCache[tabId].links = message.links;
    policyCache[tabId].domain = extractDomain(sender.tab.url);

    // If we have links, start fetching their content
    if (
      (message.links.terms.length > 0 || message.links.privacy.length > 0) &&
      !policyCache[tabId].fetchStarted
    ) {
      policyCache[tabId].fetchStarted = true;
      fetchPolicies(tabId, message.links);
    } else if (
      message.links.terms.length === 0 &&
      message.links.privacy.length === 0
    ) {
      // No links found - use fallback analysis
      const domain = extractDomain(sender.tab.url);

      // Create a basic fallback analysis
      const fallbackAnalysis = createFallbackAnalysis(
        domain,
        [],
        [],
        [],
        20 // Default low-medium risk score
      );

      // Store fallback analysis
      analysisCache[tabId] = {
        ...fallbackAnalysis,
        domain: domain,
        timestamp: Date.now(),
        isFallback: true,
        message: "No policy documents found on this website.",
      };

      updateBadge(tabId);
    }

    updateBadge(tabId);
    sendResponse({ success: true });
  } else if (message.action === "getTabAnalysis") {
    sendResponse({
      analysis: analysisCache[message.tabId] || null,
    });
  } else if (message.action === "analyzeContent") {
    // Check if we have an API key
    chrome.storage.local.get(["openaiApiKey"], async (result) => {
      if (result.openaiApiKey) {
        const domain = extractDomain(message.url);

        // Analyze the content
        analyzeContent(
          message.tabId,
          message.content,
          domain,
          result.openaiApiKey
        );

        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: "Missing API key" });
      }
    });
    return true; // Keep the message channel open for async response
  } else if (message.action === "manualAnalysis") {
    // Handle manual analysis request from popup
    const tabId = message.tabId;
    const url = message.url;
    const domain = extractDomain(url);

    // Clear any existing analysis for this tab
    delete analysisCache[tabId];

    // Show loading indicator
    chrome.action.setBadgeText({ text: "...", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#FFC107", tabId });

    // Force search for policy links
    searchPolicyLinks(domain, tabId, true);
    sendResponse({ success: true });
    return false;
  }
});

// Proactively search for policy links using common patterns
async function searchPolicyLinks(domain, tabId, isManual = false) {
  if (!domain || domain === "") return;

  // Don't search again if we already have analysis for this domain and it's not a manual request
  if (
    !isManual &&
    analysisCache[tabId] &&
    analysisCache[tabId].domain === domain
  ) {
    return;
  }

  // Initialize the policy cache for this tab
  if (!policyCache[tabId]) {
    policyCache[tabId] = {};
    policyCache[tabId].domain = domain;
  }

  // Common paths for terms and privacy policies
  const commonTermsPaths = [
    "/terms",
    "/terms-of-service",
    "/terms-of-use",
    "/terms-conditions",
    "/legal",
    "/tos",
    "/terms.html",
    "/terms-of-service.html",
    "/about/legal/terms",
    "/legal/terms",
  ];

  const commonPrivacyPaths = [
    "/privacy",
    "/privacy-policy",
    "/data-policy",
    "/data-protection",
    "/privacy.html",
    "/privacy-policy.html",
    "/about/privacy",
    "/legal/privacy",
  ];

  // Construct URLs to check
  const baseURL = `https://${domain}`;
  let termsLinks = commonTermsPaths.map((path) => ({
    url: baseURL + path,
    text: "Terms of Service",
  }));
  let privacyLinks = commonPrivacyPaths.map((path) => ({
    url: baseURL + path,
    text: "Privacy Policy",
  }));

  // Also try www subdomain if domain doesn't already start with www
  if (!domain.startsWith("www.")) {
    const wwwBaseURL = `https://www.${domain}`;
    termsLinks = termsLinks.concat(
      commonTermsPaths.map((path) => ({
        url: wwwBaseURL + path,
        text: "Terms of Service",
      }))
    );
    privacyLinks = privacyLinks.concat(
      commonPrivacyPaths.map((path) => ({
        url: wwwBaseURL + path,
        text: "Privacy Policy",
      }))
    );
  }

  // Initialize fetchStarted flag
  policyCache[tabId].fetchStarted = true;

  // Create links object and fetch policies
  const links = {
    terms: termsLinks,
    privacy: privacyLinks,
  };

  policyCache[tabId].links = links;

  // Update badge to indicate fetching
  chrome.action.setBadgeText({ text: "...", tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#FFC107", tabId });

  // Set a timeout to prevent hanging in the loading state forever
  if (fetchTimeouts[tabId]) {
    clearTimeout(fetchTimeouts[tabId]);
  }

  fetchTimeouts[tabId] = setTimeout(() => {
    // Check if we're still in loading state
    if (
      policyCache[tabId] &&
      policyCache[tabId].fetchStarted &&
      !analysisCache[tabId]
    ) {
      console.log("Fetch timeout reached, creating fallback analysis");
      // Create a fallback analysis
      const fallbackAnalysis = createFallbackAnalysis(
        domain,
        [],
        [],
        [],
        20 // Default low-medium risk
      );

      // Store fallback analysis with timeout message
      analysisCache[tabId] = {
        ...fallbackAnalysis,
        domain: domain,
        timestamp: Date.now(),
        isFallback: true,
        message:
          "Analysis timed out. The policies may be difficult to locate or process.",
      };

      updateBadge(tabId);
    }
  }, 30000); // 30 second timeout

  // Fetch the policies
  fetchPolicies(tabId, links);
}

// Show notification based on risk score
function showRiskNotification(domain, riskScore) {
  // Check if notifications are enabled
  chrome.storage.local.get(["showNotifications"], (result) => {
    if (result.showNotifications === undefined) {
      // Default to enabled if not set
      result.showNotifications = true;
    }

    if (result.showNotifications) {
      let riskLevel = "Low";
      let color = "#4CAF50"; // Green for low risk

      if (riskScore >= 70) {
        riskLevel = "High";
        color = "#F44336"; // Red for high risk
      } else if (riskScore >= 40) {
        riskLevel = "Medium";
        color = "#FF9800"; // Orange for medium risk
      }

      // Only show notifications for medium and high risk
      if (riskScore >= 40) {
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: `${riskLevel} Risk Terms Detected`,
          message: `The terms for ${domain} have a risk score of ${riskScore}/100.`,
          priority: 2,
        });
      }
    }
  });
}

// Extract domain from URL
function extractDomain(url) {
  try {
    const urlObj = new URL(url);
    let hostname = urlObj.hostname;

    // Remove www prefix for consistency
    hostname = hostname.replace(/^www\./, "");

    return hostname;
  } catch (e) {
    console.error("Error extracting domain:", e);
    return url;
  }
}

// Update badge to show when analysis is ready and indicate risk level
function updateBadge(tabId) {
  if (analysisCache[tabId]) {
    // We have analysis results - show risk level
    const riskScore = analysisCache[tabId].riskScore;
    let badgeText = "L"; // Low risk
    let badgeColor = "#4CAF50"; // Green

    if (riskScore >= 70) {
      badgeText = "H"; // High risk
      badgeColor = "#F44336"; // Red
    } else if (riskScore >= 40) {
      badgeText = "M"; // Medium risk
      badgeColor = "#FF9800"; // Orange
    }

    chrome.action.setBadgeText({ text: badgeText, tabId });
    chrome.action.setBadgeBackgroundColor({ color: badgeColor, tabId });

    // Show notification for high risk sites
    if (riskScore >= 70) {
      showRiskNotification(analysisCache[tabId].domain, riskScore);
    }
  } else if (policyCache[tabId] && policyCache[tabId].fetchStarted) {
    // Fetching in progress
    chrome.action.setBadgeText({ text: "...", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#FFC107", tabId });
  } else {
    // Nothing yet
    chrome.action.setBadgeText({ text: "", tabId });
  }
}


// Fetch policy content from discovered links
async function fetchPolicies(tabId, links) {
  policyCache[tabId].timestamp = Date.now();
  const fetchPromises = [];

  // Try to fetch terms links - attempt each URL until one works
  if (links.terms.length > 0) {
    const termsPromise = tryFetchMultipleUrls(links.terms, "terms")
      .then((content) => {
        if (!policyCache[tabId]) policyCache[tabId] = {};
        if (content) {
          policyCache[tabId].termsContent = content;
        }
        return content;
      })
      .catch((error) => {
        console.error("Error fetching terms:", error);
        return null;
      });

    fetchPromises.push(termsPromise);
  }

  // Try to fetch privacy links - attempt each URL until one works
  if (links.privacy.length > 0) {
    const privacyPromise = tryFetchMultipleUrls(links.privacy, "privacy")
      .then((content) => {
        if (!policyCache[tabId]) policyCache[tabId] = {};
        if (content) {
          policyCache[tabId].privacyContent = content;
        }
        return content;
      })
      .catch((error) => {
        console.error("Error fetching privacy policy:", error);
        return null;
      });

    fetchPromises.push(privacyPromise);
  }

  // Wait for both fetches to complete or timeout after 20 seconds
  Promise.race([
    Promise.all(fetchPromises),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Fetch timeout")), 20000)
    ),
  ])
    .then(async (results) => {
      // Check if we have any content
      const hasContent = results.some(
        (content) => content && content.length > 500
      );

      if (hasContent) {
        // Combine content for analysis
        let combinedContent = "";

        if (policyCache[tabId] && policyCache[tabId].termsContent) {
          combinedContent +=
            "TERMS OF SERVICE:\n\n" + policyCache[tabId].termsContent + "\n\n";
        }

        if (policyCache[tabId] && policyCache[tabId].privacyContent) {
          combinedContent +=
            "PRIVACY POLICY:\n\n" + policyCache[tabId].privacyContent;
        }

        // Try to analyze the content
        try {
          // Get API key
          const { openaiApiKey } = await chrome.storage.local.get([
            "openaiApiKey",
          ]);

          if (openaiApiKey) {
            const domain = policyCache[tabId].domain;
            analyzeContent(tabId, combinedContent, domain, openaiApiKey);
          } else {
            // No API key - use fallback analysis
            const domain = policyCache[tabId].domain;

            // Perform basic analysis
            const lowerText = combinedContent.toLowerCase();
            const {
              highRiskMatches,
              mediumRiskMatches,
              lowRiskMatches,
              initialRiskScore,
            } = performBasicAnalysis(lowerText);

            const fallbackAnalysis = createFallbackAnalysis(
              domain,
              highRiskMatches,
              mediumRiskMatches,
              lowRiskMatches,
              initialRiskScore
            );

            // Store fallback analysis
            analysisCache[tabId] = {
              ...fallbackAnalysis,
              domain: domain,
              timestamp: Date.now(),
              isFallback: true,
            };

            updateBadge(tabId);
          }
        } catch (error) {
          console.error("Error during analysis:", error);

          // Create fallback analysis on error
          const domain = policyCache[tabId].domain;
          const fallbackAnalysis = createFallbackAnalysis(
            domain,
            [],
            [],
            [],
            30 // Default medium-low risk
          );

          // Store fallback analysis with error message
          analysisCache[tabId] = {
            ...fallbackAnalysis,
            domain: domain,
            timestamp: Date.now(),
            isFallback: true,
            message: "Error during analysis. Try again or check settings.",
          };

          updateBadge(tabId);
        }
      } else {
        // No content found - create fallback analysis
        const domain = policyCache[tabId].domain;
        const fallbackAnalysis = createFallbackAnalysis(
          domain,
          [],
          [],
          [],
          20 // Default low-medium risk
        );

        // Store fallback analysis with no content message
        analysisCache[tabId] = {
          ...fallbackAnalysis,
          domain: domain,
          timestamp: Date.now(),
          isFallback: true,
          message:
            "No policy content could be retrieved. The site may not have accessible policies.",
        };

        updateBadge(tabId);
      }
    })
    .catch((error) => {
      console.error("Policy fetch failed:", error);

      // Create fallback analysis on fetch failure
      const domain = policyCache[tabId].domain;
      const fallbackAnalysis = createFallbackAnalysis(
        domain,
        [],
        [],
        [],
        35 // Default medium risk (slightly higher because we couldn't analyze)
      );

      // Store fallback analysis with fetch error message
      analysisCache[tabId] = {
        ...fallbackAnalysis,
        domain: domain,
        timestamp: Date.now(),
        isFallback: true,
        message:
          "Could not fetch or process policies. Click 'Policy Links' to try manual discovery.",
      };

      updateBadge(tabId);
    });
}

// Try to fetch from multiple URLs until one succeeds
async function tryFetchMultipleUrls(urlObjects, type) {
  for (let i = 0; i < urlObjects.length; i++) {
    try {
      const content = await fetchPolicyContent(urlObjects[i].url, type);
      if (content && content.length > 500) {
        return content;
      }
    } catch (e) {
      console.log(`Failed to fetch from ${urlObjects[i].url}`, e);
      // Continue to next URL
    }
  }

  // If all URLs fail, return null
  return null;
}

// Fetch content from a URL
async function fetchPolicyContent(url, type) {
  // Use fetch via a background script fetch (we need to use XMLHttpRequest in MV3)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.timeout = 10000; // 10 seconds timeout

    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          // Parse HTML
          const parser = new DOMParser();
          const doc = parser.parseFromString(xhr.responseText, "text/html");

          // Remove script tags and other non-content elements
          const scripts = doc.querySelectorAll(
            "script, style, noscript, iframe, img, svg, header, footer, nav"
          );
          scripts.forEach((script) => script.remove());

          // Extract text
          let text = "";

          // Try specific content containers first
          let contentFound = false;

          // Try to find the main content first
          const mainSelectors = [
            "main",
            "article",
            "#content",
            ".content",
            "#main-content",
            ".main-content",
            ".container",
            ".main",
            ".body",
            "#body",
            "body > div:nth-child(1)",
            ".page",
            "#page",
            ".page-content",
          ];

          // Add specific selectors based on the policy type
          if (type === "terms") {
            mainSelectors.unshift(
              "#terms",
              ".terms",
              "#terms-of-service",
              ".terms-of-service",
              "#terms-conditions",
              ".terms-conditions",
              "#legal",
              ".legal",
              '[id*="terms"]',
              '[class*="terms"]',
              '[id*="tos"]',
              '[class*="tos"]'
            );
          } else if (type === "privacy") {
            mainSelectors.unshift(
              "#privacy",
              ".privacy",
              "#privacy-policy",
              ".privacy-policy",
              "#data-policy",
              ".data-policy",
              '[id*="privacy"]',
              '[class*="privacy"]'
            );
          }

          // Try each selector
          for (const selector of mainSelectors) {
            const elements = doc.querySelectorAll(selector);
            if (elements && elements.length > 0) {
              for (const el of elements) {
                const content = el.textContent.trim();
                if (content.length > 200) {
                  // Must be substantial content
                  text = content;
                  contentFound = true;
                  break;
                }
              }
              if (contentFound) break;
            }
          }

          // Fallback: if no main content found, try getting all paragraphs
          if (!contentFound || text.length < 500) {
            const paragraphs = doc.querySelectorAll("p");
            if (paragraphs.length > 5) {
              // Only use if we have multiple paragraphs
              text = Array.from(paragraphs)
                .map((p) => p.textContent.trim())
                .join("\n\n");
            }
          }

          // Last resort: use body text
          if (!text || text.length < 500) {
            text = doc.body.textContent.trim();
          }

          // In the fetchPolicyContent function, add this before resolving:
          // Limit text size to prevent memory issues (100K chars should be plenty)
          if (text.length > 100000) {
            text =
              text.substring(0, 100000) +
              "... [content truncated for memory efficiency]";
          }
          resolve(text);
        } catch (parseError) {
          console.error("Error parsing HTML content:", parseError);
          // As a fallback, just return the raw text content
          resolve(xhr.responseText);
        }
      } else {
        reject(new Error(`Failed to fetch policy: ${xhr.status}`));
      }
    };

    xhr.onerror = function () {
      reject(new Error("Network error occurred"));
    };

    xhr.ontimeout = function () {
      reject(new Error("Request timeout"));
    };

    xhr.send();
  });
}

// Perform basic text analysis to find risk patterns
function performBasicAnalysis(text) {
  // Define risk patterns for basic analysis
  const riskPatterns = {
    highRisk: [
      "sell your data",
      "share with third parties",
      "unlimited license",
      "no obligation to protect",
      "waive right to class action",
      "mandatory arbitration",
      "modify terms without notice",
      "perpetual license",
      "worldwide license",
      "irrevocable license",
      "sell personal information",
      "share with partners",
      "waive rights",
      "binding arbitration",
      "no refunds",
      "no liability",
      "exclusive jurisdiction",
      "limitation of liability",
      "right to monitor",
      "retain indefinitely",
      "store your content",
      "transfer your data",
      "facial recognition",
      "sell to third parties",
      "share with advertisers",
      "biometric data",
      "waive right to sue",
    ],
    mediumRisk: [
      "collect location data",
      "track your activity",
      "personalized advertising",
      "share aggregated data",
      "retain data indefinitely",
      "automatically renew",
      "cookies and tracking",
      "third-party analytics",
      "behavioral tracking",
      "targeted advertising",
      "marketing emails",
      "data retention",
      "monitor usage",
      "track behavior",
      "cross-device tracking",
      "interest-based ads",
      "can't opt out",
      "cannot opt out",
      "may share",
      "may collect",
      "may use",
    ],
    lowRisk: [
      "necessary cookies",
      "essential account information",
      "standard analytics",
      "communicate updates",
      "security measures",
      "data portability",
      "opt-out options",
      "delete account",
      "access your data",
      "data protection",
      "right to delete",
      "right to access",
      "right to object",
      "data subject rights",
      "can opt out",
      "may opt out",
      "gdpr compliant",
      "ccpa compliant",
    ],
  };

  // Find matches
  const highRiskMatches = [];
  const mediumRiskMatches = [];
  const lowRiskMatches = [];

  riskPatterns.highRisk.forEach((pattern) => {
    if (text.includes(pattern.toLowerCase())) {
      highRiskMatches.push(pattern);
    }
  });

  riskPatterns.mediumRisk.forEach((pattern) => {
    if (text.includes(pattern.toLowerCase())) {
      mediumRiskMatches.push(pattern);
    }
  });

  riskPatterns.lowRisk.forEach((pattern) => {
    if (text.includes(pattern.toLowerCase())) {
      lowRiskMatches.push(pattern);
    }
  });

  // Replace the risk scoring with:
  // Calculate initial risk score
  let initialRiskScore =
    highRiskMatches.length * 15 +
    mediumRiskMatches.length * 7 -
    lowRiskMatches.length * 3;

  // Add baseline score
  initialRiskScore += 10; // Base risk score

  // Cap minimum and maximum
  initialRiskScore = Math.max(5, Math.min(95, initialRiskScore));

  // Normalize if we have an extremely high number of matches
  if (
    highRiskMatches.length + mediumRiskMatches.length + lowRiskMatches.length >
    20
  ) {
    initialRiskScore = Math.min(initialRiskScore, 90); // Cap max score with many matches
  }

  return {
    highRiskMatches,
    mediumRiskMatches,
    lowRiskMatches,
    initialRiskScore,
  };
}

// Analyze content using OpenAI API
async function analyzeContent(tabId, content, domain, apiKey) {
  // Truncate content if too long
  const truncatedContent =
    content.length > 8000 ? content.substring(0, 8000) + "..." : content;

  // Perform basic analysis first
  const lowerText = truncatedContent.toLowerCase();
  const {
    highRiskMatches,
    mediumRiskMatches,
    lowRiskMatches,
    initialRiskScore,
  } = performBasicAnalysis(lowerText);

  // Prepare OpenAI request
  const prompt = `
Analyze the following Terms & Conditions and/or Privacy Policy from ${domain}.

Initial automated analysis found:
- High risk factors: ${highRiskMatches.join(", ") || "None"}
- Medium risk factors: ${mediumRiskMatches.join(", ") || "None"}
- Low risk factors: ${lowRiskMatches.join(", ") || "None"}
- Initial risk score: ${initialRiskScore}/100

TEXT TO ANALYZE:
${truncatedContent}

Even if this isn't explicitly a terms of service page, analyze it as if it were and extract any relevant legal or policy information.

Provide the following:
1. A concise summary (maximum 5 bullet points) of the most important points
2. An overall risk assessment score (0-100)
3. A list of 3-5 specific risk factors with:
   - Title
   - Brief description
   - Risk level (high/medium/low)

Format your response as JSON:
{
  "summary": "Bullet point summary in HTML format",
  "riskScore": number,
  "riskFactors": [
    {
      "title": "string",
      "description": "string",
      "level": "high|medium|low"
    }
  ]
}
`;

  try {
    // Make API request
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content:
              "You are a legal expert that analyzes Terms & Conditions and Privacy Policies. Format your response strictly as JSON.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();

    // Try to parse the JSON response
    let analysis;

    // Replace the try-catch block around line 594 with:
    try {
      if (
        !data.choices ||
        !data.choices[0] ||
        !data.choices[0].message ||
        !data.choices[0].message.content
      ) {
        throw new Error("Unexpected API response format");
      }

      analysis = JSON.parse(data.choices[0].message.content.trim());
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      // If that fails, try to extract JSON from the text
      const jsonMatch = data.choices[0].message.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          analysis = JSON.parse(jsonMatch[0]);
        } catch (secondError) {
          throw new Error("Could not parse JSON from response");
        }
      } else {
        throw new Error("Could not extract JSON from response");
      }
    }

    // Store the analysis in cache
    analysisCache[tabId] = {
      ...analysis,
      domain: domain,
      timestamp: Date.now(),
    };

    // Show notification for high risk sites
    if (analysis.riskScore >= 70) {
      showRiskNotification(domain, analysis.riskScore);
    }

    // Update badge
    updateBadge(tabId);
  } catch (error) {
    console.error("API Error:", error);

    // Use fallback analysis
    const fallbackAnalysis = createFallbackAnalysis(
      domain,
      highRiskMatches,
      mediumRiskMatches,
      lowRiskMatches,
      initialRiskScore
    );

    // Store fallback analysis
    analysisCache[tabId] = {
      ...fallbackAnalysis,
      domain: domain,
      timestamp: Date.now(),
      isFallback: true,
      message: "OpenAI API analysis failed. Using basic analysis instead.",
    };

    updateBadge(tabId);
  }
}

// Create fallback analysis when API fails
function createFallbackAnalysis(
  domain,
  highRiskMatches,
  mediumRiskMatches,
  lowRiskMatches,
  initialRiskScore
) {
  // Create summary points based on pattern matches
  let summaryPoints = [];

  if (highRiskMatches.length > 0) {
    summaryPoints.push(
      `${domain} includes ${highRiskMatches.length} high-risk terms that may affect your privacy or rights.`
    );
  }

  if (mediumRiskMatches.length > 0) {
    summaryPoints.push(
      `Contains ${mediumRiskMatches.length} medium-risk terms related to data usage and tracking.`
    );
  }

  if (lowRiskMatches.length > 0) {
    summaryPoints.push(
      `Includes ${lowRiskMatches.length} standard or low-risk terms common in most services.`
    );
  }

  // If we don't have any matches, add generic points
  if (summaryPoints.length === 0) {
    summaryPoints.push(
      `${domain} may have terms and policies that warrant review.`
    );
    summaryPoints.push(
      `Basic analysis could not identify specific risk patterns.`
    );
  }

  // Add general advice
  summaryPoints.push(
    "Be cautious about how your data may be used or shared with third parties."
  );
  summaryPoints.push(
    "Consider reviewing the full terms to understand all implications before agreeing."
  );

  // Build fallback analysis
  const fallbackAnalysis = {
    summary: `<ul>${summaryPoints
      .map((point) => `<li>${point}</li>`)
      .join("")}</ul>`,
    riskScore: initialRiskScore,
    riskFactors: [],
  };

  // Add high risk matches as factors
  highRiskMatches.slice(0, 3).forEach((match) => {
    fallbackAnalysis.riskFactors.push({
      title: `Contains "${match}"`,
      description:
        "This pattern typically indicates higher risk to user privacy or rights.",
      level: "high",
    });
  });

  // Add medium risk matches
  mediumRiskMatches.slice(0, 2).forEach((match) => {
    fallbackAnalysis.riskFactors.push({
      title: `Contains "${match}"`,
      description: "This pattern indicates moderate concern for user privacy.",
      level: "medium",
    });
  });

  // Ensure we have at least 3 factors
  if (fallbackAnalysis.riskFactors.length < 3) {
    // Add generic risk factors if we don't have enough specific ones
    const genericFactors = [
      {
        title: "Limited Analysis Available",
        description:
          "Could not perform full analysis of terms, which may hide potentially concerning clauses.",
        level: "medium",
      },
      {
        title: "Data Collection",
        description:
          "Most websites collect some form of user data, which poses inherent privacy risks.",
        level: "medium",
      },
      {
        title: "Third-Party Sharing",
        description:
          "Many services share data with third parties for various purposes including analytics and advertising.",
        level: "medium",
      },
    ];

    // Add generic factors until we have at least 3
    for (
      let i = 0;
      i < genericFactors.length && fallbackAnalysis.riskFactors.length < 3;
      i++
    ) {
      fallbackAnalysis.riskFactors.push(genericFactors[i]);
    }
  }

  return fallbackAnalysis;
}

// Clean up old cache entries periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  
  // Clean analysis cache
  Object.keys(analysisCache).forEach(tabId => {
    if (analysisCache[tabId].timestamp && (now - analysisCache[tabId].timestamp) > maxAge) {
      delete analysisCache[tabId];
    }
  });
  
  // Clean policy cache
  Object.keys(policyCache).forEach(tabId => {
    if (policyCache[tabId].timestamp && (now - policyCache[tabId].timestamp) > maxAge) {
      delete policyCache[tabId];
    }
  });
  
  // Clean fetchTimeouts
  Object.keys(fetchTimeouts).forEach(tabId => {
    if (!policyCache[tabId] || (now - policyCache[tabId].timestamp) > maxAge) {
      if (fetchTimeouts[tabId]) {
        clearTimeout(fetchTimeouts[tabId]);
        delete fetchTimeouts[tabId];
      }
    }
  });
}, 3600000); // Check every hour

// Listen for settings changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    // Handle API key changes
    if (changes.openaiApiKey) {
      console.log("API key changed, clearing analysis cache");
      analysisCache = {};
    }

    // Handle auto-analyze changes
    if (changes.autoAnalyze) {
      if (changes.autoAnalyze.newValue) {
        console.log("Auto-analyze enabled, starting analysis for active tab");
        if (activeTabId) {
          chrome.tabs.get(activeTabId, (tab) => {
            if (tab && tab.url && tab.url.startsWith("http")) {
              const domain = extractDomain(tab.url);
              searchPolicyLinks(domain, activeTabId);
            }
          });
        }
      } else {
        console.log("Auto-analyze disabled, clearing badges");
        // Clear badges on all tabs
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach((tab) => {
            chrome.action.setBadgeText({ text: "", tabId: tab.id });
          });
        });
      }
    }
  }
});

// Add this listener near the other listeners (around line 673):
// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  // Remove data for closed tabs
  if (policyCache[tabId]) {
    delete policyCache[tabId];
  }
  if (analysisCache[tabId]) {
    delete analysisCache[tabId];
  }
  if (fetchTimeouts[tabId]) {
    clearTimeout(fetchTimeouts[tabId]);
    delete fetchTimeouts[tabId];
  }
  if (domainToTabId[tabId]) {
    delete domainToTabId[tabId];
  }
});

// Initialize extension
chrome.runtime.onInstalled.addListener(() => {
  // Set default settings if not already set
  chrome.storage.local.get(["autoAnalyze", "showNotifications"], (result) => {
    if (result.autoAnalyze === undefined) {
      chrome.storage.local.set({ autoAnalyze: true });
    }

    if (result.showNotifications === undefined) {
      chrome.storage.local.set({ showNotifications: true });
    }
  });

  console.log("Policy Analyzer extension installed");
});
