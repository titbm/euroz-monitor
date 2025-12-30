require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Config
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHECK_INTERVAL = (process.env.CHECK_INTERVAL_MINUTES || 1) * 60 * 1000;
// Use /data for persistent storage on Fly.io, fallback to local for dev
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const SUBSCRIBERS_FILE = path.join(DATA_DIR, 'subscribers.json');
const LAST_BLOCK_FILE = path.join(DATA_DIR, 'last_block.json');

// Owner address to monitor
const OWNER_ADDRESS = '0x3956b9d971f6dd97bdcb0899f6af0df01ecc3acf';

// Auction bot address to monitor
const AUCTION_BOT_ADDRESS = '0x039024c979b7e460fa660b9ff1475f58e16aa88d';
const AUCTION_FACTORY_ADDRESS = '0x1E42B753C08f7D4aC55149BCE0DABcDE2028594d';

// Event signatures for Paused/Unpaused
const PAUSED_EVENT = ethers.id('Paused(address)');
const UNPAUSED_EVENT = ethers.id('Unpaused(address)');

// Event signature for AuctionCreated
const AUCTION_CREATED_EVENT = '0x589ecc317a03e0d220dce8b8543b0f0b532b364ebe386ba0bdc6535e7f47bb14';

// Sepolia RPC
const RPC_URLS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://sepolia.drpc.org',
  'https://1rpc.io/sepolia'
];
const provider = new ethers.JsonRpcProvider(RPC_URLS[0]);

// Contracts
const CONTRACTS = {
  EUROZ: {
    address: '0xED1B7De57918f6B7c8a7a7767557f09A80eC2a35',
    name: 'EUROZ (mint)',
    etherscan: 'https://sepolia.etherscan.io/address/0xED1B7De57918f6B7c8a7a7767557f09A80eC2a35',
    pauseMethod: 'paused'
  },
  cEUROZ: {
    address: '0xCD25e0e4972e075C371948c7137Bcd498C1F4e89',
    name: 'cEUROZ (wrap)',
    etherscan: 'https://sepolia.etherscan.io/address/0xCD25e0e4972e075C371948c7137Bcd498C1F4e89',
    pauseMethod: 'pausableToken'
  }
};

// ABI for pause checking
const PAUSED_ABI = [
  'function paused() view returns (bool)',
  'function pausableToken() view returns (address)'
];

// State
let lastStatus = { EUROZ: null, cEUROZ: null };
let subscribers = new Set();
let lastCheckedBlock = 0;
let lastPauseEvent = null; // Store last known pause/unpause event
let lastCheckedAuctionBlock = 0;
let lastAuctionEvent = null; // Store last known auction creation event
let lastWebsiteStatus = null; // Store last website status (true = maintenance, false = working)
let lastCheckedNFTBlock = 0;
let lastNFTMint = null; // Store last known NFT mint event
let lastNFTMintTime = null; // Timestamp of last mint
let nftMintingActive = false; // Track if minting is currently active

// Initial subscribers (backup)
const INITIAL_SUBSCRIBERS = [];

// Last known pause event (from block 9867324)
const INITIAL_PAUSE_EVENT = {
  hash: '0x5af14d4be4d2ef3d1dd9edc28e7b7f73a9f35a77c4bb714e799c9276d9aca1d1',
  action: 'pause',
  block: 9867324,
  timestamp: 1766071680000 // 2025-12-18T15:28:00Z
};

// Last known auction creation (from block 9867417)
const INITIAL_AUCTION_EVENT = {
  hash: '0xbbeb989f5d63395ad969525eed012e959796c482f0a49c7bea97a6f903c5e702',
  block: 9867417,
  timestamp: 1766072868000 // 2025-12-18T15:47:48Z
};

// Last known NFT mint (from block 9946324)
const INITIAL_NFT_MINT = {
  hash: '0x28c4d13c35dc8e463cf052c4dc7cf7ff2ca5dbdba49d1155f078eaf2fdc88857',
  block: 9946324,
  timestamp: 1735575576000, // 2025-12-30T16:29:36Z
  to: '0xB76A0af3440ba1f1a59a38dd5b7a2f1a8d8f8361',
  tokenId: 4
};

// Gachapon NFT config
const GACHAPON_NFT_ADDRESS = '0xfdd14d2a2e1ea940392f4c8851cc217dde474541';
const TRANSFER_SINGLE_EVENT = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62'; // TransferSingle event signature

// Load subscribers from file
function loadSubscribers() {
  try {
    if (fs.existsSync(SUBSCRIBERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8'));
      subscribers = new Set(data);
      console.log(`Loaded ${subscribers.size} subscribers from file`);
    } else {
      // Use initial subscribers if file doesn't exist
      subscribers = new Set(INITIAL_SUBSCRIBERS);
      saveSubscribers();
      console.log(`Initialized ${subscribers.size} subscribers from backup`);
    }
  } catch (err) {
    console.error('Error loading subscribers:', err.message);
    subscribers = new Set(INITIAL_SUBSCRIBERS);
  }
}

// Save subscribers to file
function saveSubscribers() {
  try {
    fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify([...subscribers]), 'utf8');
  } catch (err) {
    console.error('Error saving subscribers:', err.message);
  }
}

// Load last checked block
function loadLastBlock() {
  try {
    if (fs.existsSync(LAST_BLOCK_FILE)) {
      const data = JSON.parse(fs.readFileSync(LAST_BLOCK_FILE, 'utf8'));
      lastCheckedBlock = data.block || 0;
      lastPauseEvent = data.lastPauseEvent || INITIAL_PAUSE_EVENT;
      lastCheckedAuctionBlock = data.auctionBlock || 0;
      // Use INITIAL_AUCTION_EVENT if lastAuctionEvent is null or undefined
      lastAuctionEvent = data.lastAuctionEvent || INITIAL_AUCTION_EVENT;
      lastWebsiteStatus = data.websiteStatus !== undefined ? data.websiteStatus : null;
      lastCheckedNFTBlock = data.nftBlock || 0;
      lastNFTMint = data.lastNFTMint || INITIAL_NFT_MINT;
      lastNFTMintTime = data.lastNFTMintTime || null;
      nftMintingActive = data.nftMintingActive || false;
      
      // FIX: Correct any wrong timestamp (force use INITIAL_NFT_MINT if timestamp doesn't match)
      const CORRECT_TIMESTAMP = 1735575576000; // Dec-30-2025 04:29:36 PM UTC
      let needsSave = false;
      
      console.log(`DEBUG: Loaded NFT mint data:`, JSON.stringify(lastNFTMint));
      console.log(`DEBUG: Expected timestamp: ${CORRECT_TIMESTAMP}, Got: ${lastNFTMint?.timestamp}`);
      
      if (lastNFTMint && lastNFTMint.timestamp !== CORRECT_TIMESTAMP) {
        console.log(`⚠️ Detected incorrect NFT mint timestamp: ${lastNFTMint.timestamp}, correcting to ${CORRECT_TIMESTAMP}...`);
        lastNFTMint = INITIAL_NFT_MINT;
        needsSave = true;
      }
      
      if (lastNFTMintTime && lastNFTMintTime !== CORRECT_TIMESTAMP) {
        console.log(`⚠️ Detected incorrect NFT mint time: ${lastNFTMintTime}, correcting to ${CORRECT_TIMESTAMP}...`);
        lastNFTMintTime = CORRECT_TIMESTAMP;
        needsSave = true;
      }
      
      console.log(`Loaded last block: ${lastCheckedBlock}, auction block: ${lastCheckedAuctionBlock}`);
      
      // If lastAuctionEvent was null in file, save the initial one
      if (!data.lastAuctionEvent) {
        saveLastBlock(null, null, null, INITIAL_AUCTION_EVENT);
        needsSave = false; // Already saving
      }
      
      // Save corrected data if needed
      if (needsSave) {
        console.log('✅ Saving corrected timestamp to file...');
        saveLastBlock(null, null, null, null, null, null, lastNFTMint, lastNFTMintTime);
      }
    } else {
      // Use initial events
      lastPauseEvent = INITIAL_PAUSE_EVENT;
      lastAuctionEvent = INITIAL_AUCTION_EVENT;
      lastNFTMint = INITIAL_NFT_MINT;
    }
  } catch (err) {
    console.error('Error loading last block:', err.message);
    lastPauseEvent = INITIAL_PAUSE_EVENT;
    lastAuctionEvent = INITIAL_AUCTION_EVENT;
  }
}

// Save last checked block
function saveLastBlock(block, pauseEvent = null, auctionBlock = null, auctionEvent = null, websiteStatus = null, nftBlock = null, nftMint = null, nftMintTime = null, mintingActive = null) {
  try {
    if (block !== null) lastCheckedBlock = block;
    if (pauseEvent) lastPauseEvent = pauseEvent;
    if (auctionBlock !== null) lastCheckedAuctionBlock = auctionBlock;
    if (auctionEvent) lastAuctionEvent = auctionEvent;
    if (websiteStatus !== null) lastWebsiteStatus = websiteStatus;
    if (nftBlock !== null) lastCheckedNFTBlock = nftBlock;
    if (nftMint) lastNFTMint = nftMint;
    if (nftMintTime !== null) lastNFTMintTime = nftMintTime;
    if (mintingActive !== null) nftMintingActive = mintingActive;
    
    fs.writeFileSync(LAST_BLOCK_FILE, JSON.stringify({ 
      block: lastCheckedBlock, 
      lastPauseEvent,
      auctionBlock: lastCheckedAuctionBlock,
      lastAuctionEvent,
      websiteStatus: lastWebsiteStatus,
      nftBlock: lastCheckedNFTBlock,
      lastNFTMint,
      lastNFTMintTime,
      nftMintingActive
    }), 'utf8');
  } catch (err) {
    console.error('Error saving last block:', err.message);
  }
}

// Initialize bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

async function checkPaused(contractKey) {
  const contractInfo = CONTRACTS[contractKey];
  const contract = new ethers.Contract(contractInfo.address, PAUSED_ABI, provider);

  // Retry logic for RPC calls
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (contractInfo.pauseMethod === 'paused') {
        return await contract.paused();
      } else if (contractInfo.pauseMethod === 'pausableToken') {
        const pausableAddr = await contract.pausableToken();
        const pausableContract = new ethers.Contract(pausableAddr, PAUSED_ABI, provider);
        return await pausableContract.paused();
      }
      return null;
    } catch (err) {
      if (i === maxRetries - 1) {
        // Last retry failed
        throw err;
      }
      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
  return null;
}

async function checkAllContracts() {
  const results = {};
  for (const key of Object.keys(CONTRACTS)) {
    try {
      results[key] = await checkPaused(key);
    } catch (err) {
      console.error(`Error checking ${key}:`, err.message);
      results[key] = null;
    }
  }
  return results;
}

function formatTime() {
  const now = new Date();
  const utc = now.toISOString().slice(11, 19);
  const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(11, 19);
  const kz = new Date(now.getTime() + 5 * 60 * 60 * 1000).toISOString().slice(11, 19);
  return `🕐 UTC ${utc} | MSK ${msk} | KZ ${kz}`;
}

function formatStatus(status) {
  const lines = ['📊 *EUROZ Contract Status*\n'];
  for (const [key, paused] of Object.entries(status)) {
    const icon = paused === null ? '❓' : paused ? '🔴' : '🟢';
    const state = paused === null ? 'Unknown' : paused ? 'PAUSED' : 'ACTIVE';
    lines.push(`${icon} *${CONTRACTS[key].name}*: ${state}`);
  }
  lines.push(`\n${formatTime()}`);
  return lines.join('\n');
}

async function sendToSubscribers(message) {
  let sent = 0;
  let failed = 0;
  for (const chatId of subscribers) {
    try {
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      sent++;
    } catch (err) {
      console.error(`Failed to send to ${chatId}:`, err.message);
      // Remove invalid subscribers
      if (err.response?.statusCode === 403) {
        subscribers.delete(chatId);
        saveSubscribers();
      }
      failed++;
    }
  }
  console.log(`Sent to ${sent} subscribers, ${failed} failed`);
}

async function checkWebsiteStatus() {
  return new Promise((resolve) => {
    // Check API endpoint - returns 503 when site is under maintenance
    const options = {
      hostname: 'zashapon.com',
      port: 443,
      path: '/api/tickets/pending',
      method: 'GET',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        // API returns 503 when site is under maintenance
        const isMaintenance = res.statusCode === 503;
        
        resolve({ 
          success: true, 
          isMaintenance,
          statusCode: res.statusCode
        });
      });
    });

    req.on('error', (err) => {
      console.error('Website check error:', err.message);
      resolve({ success: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'timeout' });
    });

    req.end();
  });
}

async function monitorLoop() {
  console.log('Checking contract status...');
  const status = await checkAllContracts();

  // Check if we got valid status (not all null)
  const hasValidStatus = Object.values(status).some(v => v !== null);
  
  if (!hasValidStatus) {
    console.log('⚠️ All contracts returned null - RPC error, skipping this check');
    return;
  }

  // Check for changes (only for non-null values)
  let changed = false;
  let unpaused = false;
  for (const key of Object.keys(status)) {
    // Ignore changes to/from null (RPC errors)
    if (status[key] !== null && lastStatus[key] !== null && lastStatus[key] !== status[key]) {
      changed = true;
      if (lastStatus[key] === true && status[key] === false) {
        unpaused = true;
      }
    }
  }

  // Send alert to all subscribers if status changed
  if (changed && subscribers.size > 0) {
    console.log('Status changed! Notifying subscribers...');
    let message = formatStatus(status);
    if (unpaused) {
      message = '🚨 *CONTRACTS UNPAUSED!*\n\n' + message + '\n\n✅ You can now mint/wrap tokens!';
    } else {
      message = '⚠️ *STATUS CHANGED*\n\n' + message;
    }
    await sendToSubscribers(message);
  }

  // Only update lastStatus with valid (non-null) values
  for (const key of Object.keys(status)) {
    if (status[key] !== null) {
      lastStatus[key] = status[key];
    }
  }
  
  console.log('Status:', status, `| Subscribers: ${subscribers.size}`);

  // Check owner transactions
  await checkOwnerTransactions();

  // Check website status
  await checkWebsite();

  // Check NFT mints
  await checkNFTMints();
}

async function checkWebsite() {
  const result = await checkWebsiteStatus();
  
  if (!result.success) {
    console.log('Website check failed:', result.error);
    return;
  }

  console.log(`Website status: ${result.isMaintenance ? 'MAINTENANCE' : 'WORKING'} (HTTP ${result.statusCode})`);

  // Check if status changed from maintenance to working
  if (lastWebsiteStatus === true && result.isMaintenance === false && subscribers.size > 0) {
    console.log('Website is back online! Notifying subscribers...');
    const message =
      `✅ *ZASHAPON.COM IS BACK ONLINE!*\n\n` +
      `🌐 Maintenance completed\n` +
      `🔗 https://zashapon.com/\n\n` +
      formatTime();

    await sendToSubscribers(message);
  }

  // Save current status
  if (result.isMaintenance !== lastWebsiteStatus) {
    saveLastBlock(null, null, null, null, result.isMaintenance);
  }
}

async function checkNFTMints() {
  try {
    const currentBlock = await provider.getBlockNumber();
    const now = Date.now();
    
    // Check if minting has been inactive for 30+ minutes
    if (lastNFTMintTime && nftMintingActive) {
      const timeSinceLastMint = now - lastNFTMintTime;
      const THIRTY_MINUTES = 30 * 60 * 1000;
      
      if (timeSinceLastMint > THIRTY_MINUTES) {
        console.log('NFT minting inactive for 30+ minutes, resetting state');
        nftMintingActive = false;
        saveLastBlock(null, null, null, null, null, null, null, null, false);
      }
    }
    
    // On first run, just save current block and skip
    if (lastCheckedNFTBlock === 0) {
      saveLastBlock(null, null, null, null, null, currentBlock);
      console.log(`First NFT check, starting from block ${currentBlock}`);
      return [];
    }

    // Search only from last checked block to current
    const fromBlock = lastCheckedNFTBlock + 1;
    if (fromBlock > currentBlock) return [];

    // Filter for TransferSingle events (ERC-1155 mints)
    // TransferSingle(address operator, address from, address to, uint256 id, uint256 value)
    const filter = {
      address: GACHAPON_NFT_ADDRESS,
      topics: [
        TRANSFER_SINGLE_EVENT,
        null, // operator (any)
        ethers.zeroPadValue('0x0000000000000000000000000000000000000000', 32) // from (null address = mint)
      ],
      fromBlock,
      toBlock: currentBlock
    };

    const logs = await provider.getLogs(filter);
    const events = [];

    for (const log of logs) {
      const block = await provider.getBlock(log.blockNumber);
      
      // Decode the event data
      // topics[2] is 'to' address, topics[3] is token id
      const toAddress = '0x' + log.topics[2].slice(26);
      const tokenId = parseInt(log.topics[3], 16);
      
      const event = {
        hash: log.transactionHash,
        block: log.blockNumber,
        timestamp: block.timestamp * 1000,
        to: toAddress,
        tokenId: tokenId
      };
      events.push(event);
      
      // Update last known NFT mint
      lastNFTMint = event;
      lastNFTMintTime = event.timestamp;
      console.log(`Found NFT mint: Token ID ${tokenId} to ${toAddress} at block ${log.blockNumber}`);
    }

    // Save current block as last checked
    saveLastBlock(null, null, null, null, null, currentBlock, lastNFTMint, lastNFTMintTime);
    
    // Notify only if minting just started (was inactive, now active)
    if (events.length > 0) {
      if (!nftMintingActive && subscribers.size > 0) {
        // Minting just started after being inactive
        console.log('NFT minting started! Sending notification...');
        
        const totalMints = events.length;
        const firstMint = events[0];
        const lastMint = events[events.length - 1];
        
        const message =
          `🎁 *NFT MINTING STARTED!*\n\n` +
          `🎨 Gachapon Zama NFTs are being minted\n` +
          `📊 ${totalMints} mint${totalMints > 1 ? 's' : ''} detected in this check\n` +
          `🆔 Latest Token ID: #${lastMint.tokenId}\n` +
          `📦 Block: ${lastMint.block}\n\n` +
          `🔗 [View latest mint](https://sepolia.etherscan.io/tx/${lastMint.hash})\n` +
          `🖼️ [View NFT](https://sepolia.etherscan.io/nft/${GACHAPON_NFT_ADDRESS}/${lastMint.tokenId})\n\n` +
          formatTime();

        await sendToSubscribers(message);
        
        // Mark minting as active
        nftMintingActive = true;
        saveLastBlock(null, null, null, null, null, null, null, null, true);
      } else {
        // Minting is already active, just log
        console.log(`NFT minting active: ${events.length} new mint(s), not sending notification`);
      }
    }
    
    return events;
  } catch (err) {
    console.error('Error checking NFT mints:', err.message);
    return [];
  }
}

async function checkPauseEvents() {
  try {
    const currentBlock = await provider.getBlockNumber();
    
    // On first run, just save current block and skip
    if (lastCheckedBlock === 0) {
      saveLastBlock(currentBlock);
      console.log(`First run, starting from block ${currentBlock}`);
      return [];
    }

    // Search only from last checked block to current
    const fromBlock = lastCheckedBlock + 1;
    if (fromBlock > currentBlock) return [];

    const filter = {
      address: CONTRACTS.EUROZ.address,
      topics: [[PAUSED_EVENT, UNPAUSED_EVENT]],
      fromBlock,
      toBlock: currentBlock
    };

    const logs = await provider.getLogs(filter);
    const events = [];

    for (const log of logs) {
      const block = await provider.getBlock(log.blockNumber);
      const isPause = log.topics[0] === PAUSED_EVENT;
      const event = {
        hash: log.transactionHash,
        action: isPause ? 'pause' : 'unpause',
        block: log.blockNumber,
        timestamp: block.timestamp * 1000
      };
      events.push(event);
      
      // Update last known pause event
      lastPauseEvent = event;
    }

    // Save current block as last checked
    saveLastBlock(currentBlock, lastPauseEvent);
    
    return events;
  } catch (err) {
    console.error('Error checking pause events:', err.message);
    return [];
  }
}

async function checkOwnerTransactions() {
  const events = await checkPauseEvents();
  
  // Notify about new pause/unpause events
  if (events.length > 0 && subscribers.size > 0) {
    for (const event of events) {
      const icon = event.action === 'pause' ? '🔴' : '🟢';
      const action = event.action === 'pause' ? 'PAUSED' : 'UNPAUSED';

      const message =
        `${icon} *CONTRACT ${action}!*\n\n` +
        `Contract: *EUROZ*\n` +
        `Block: ${event.block}\n\n` +
        `🔗 [View on Etherscan](https://sepolia.etherscan.io/tx/${event.hash})\n\n` +
        formatTime();

      await sendToSubscribers(message);
      console.log(`Pause event alert: ${event.action} on EUROZ`);
    }
  }

  // Check auction creation events
  await checkAuctionEvents();
}

async function checkAuctionEvents() {
  try {
    const currentBlock = await provider.getBlockNumber();
    
    // On first run, just save current block and skip
    if (lastCheckedAuctionBlock === 0) {
      saveLastBlock(null, null, currentBlock, null);
      console.log(`First auction check, starting from block ${currentBlock}`);
      return [];
    }

    // Search only from last checked block to current
    const fromBlock = lastCheckedAuctionBlock + 1;
    if (fromBlock > currentBlock) return [];

    // Filter for AuctionCreated events from auction bot
    const filter = {
      address: AUCTION_FACTORY_ADDRESS,
      topics: [
        AUCTION_CREATED_EVENT,
        null, // auctionAddress (any)
        ethers.zeroPadValue(AUCTION_BOT_ADDRESS.toLowerCase(), 32) // creator (our bot)
      ],
      fromBlock,
      toBlock: currentBlock
    };

    const logs = await provider.getLogs(filter);
    const events = [];

    for (const log of logs) {
      const block = await provider.getBlock(log.blockNumber);
      const event = {
        hash: log.transactionHash,
        block: log.blockNumber,
        timestamp: block.timestamp * 1000
      };
      events.push(event);
      
      // Update last known auction event
      lastAuctionEvent = event;
      console.log(`Found auction creation: ${event.hash} at block ${log.blockNumber}`);
    }

    // Save current block as last checked
    saveLastBlock(null, null, currentBlock, lastAuctionEvent);
    
    // Notify about new auction creations
    if (events.length > 0 && subscribers.size > 0) {
      for (const event of events) {
        const date = new Date(event.timestamp);
        const day = date.getUTCDate().toString().padStart(2, '0');
        const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
        const year = date.getUTCFullYear();
        const hours = date.getUTCHours().toString().padStart(2, '0');
        const minutes = date.getUTCMinutes().toString().padStart(2, '0');
        const seconds = date.getUTCSeconds().toString().padStart(2, '0');
        const dateTimeStr = `${day}.${month}.${year} - ${hours}:${minutes}:${seconds} UTC`;

        const message =
          `🎨 *NEW AUCTION CREATED!*\n\n` +
          `🔨 Create Auction - ${dateTimeStr}\n` +
          `Block: ${event.block}\n\n` +
          `🔗 [View transaction in Etherscan](https://sepolia.etherscan.io/tx/${event.hash})\n\n` +
          formatTime();

        await sendToSubscribers(message);
        console.log(`Auction creation alert: ${event.hash}`);
      }
    }
    
    return events;
  } catch (err) {
    console.error('Error checking auction events:', err.message);
    return [];
  }
}

// Bot commands
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const status = await checkAllContracts();
  const statusText = formatStatus(status);

  bot.sendMessage(
    chatId,
    `👋 *Welcome to EUROZ Monitor Bot!*\n\n` +
      `${statusText}\n\n` +
      `*Commands:*\n` +
      `/status - Check current status\n` +
      `/subscribe - Get notified when contracts unpause or auctions created\n` +
      `/unsubscribe - Stop notifications\n\n` +
      `This bot monitors:\n` +
      `• EUROZ and cEUROZ contracts on Sepolia\n` +
      `• Auction creation events\n` +
      `• zashapon.com website availability\n` +
      `• Gachapon Zama NFT mints`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const status = await checkAllContracts();
  const isSubscribed = subscribers.has(chatId);
  let message = formatStatus(status);

  // Show website status
  const websiteResult = await checkWebsiteStatus();
  if (websiteResult.success) {
    const websiteIcon = websiteResult.isMaintenance ? '🔴' : '🟢';
    const websiteState = websiteResult.isMaintenance ? 'MAINTENANCE' : 'ONLINE';
    message += `\n\n${websiteIcon} *zashapon.com*: ${websiteState}`;
  }

  // Show last NFT mint
  if (lastNFTMint) {
    const date = new Date(lastNFTMint.timestamp);
    const day = date.getUTCDate().toString().padStart(2, '0');
    const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
    const year = date.getUTCFullYear();
    const hours = date.getUTCHours().toString().padStart(2, '0');
    const minutes = date.getUTCMinutes().toString().padStart(2, '0');
    const seconds = date.getUTCSeconds().toString().padStart(2, '0');
    const dateTimeStr = `${day}.${month}.${year} - ${hours}:${minutes}:${seconds} UTC`;

    message += `\n\n🎁 *Last NFT minted:*\n`;
    message += `🎨 Token ID #${lastNFTMint.tokenId} - ${dateTimeStr}\n`;
    message += `[View NFT](https://sepolia.etherscan.io/nft/${GACHAPON_NFT_ADDRESS}/${lastNFTMint.tokenId})`;
  }

  // Show last known pause event
  if (lastPauseEvent) {
    const date = new Date(lastPauseEvent.timestamp);
    const day = date.getUTCDate().toString().padStart(2, '0');
    const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
    const year = date.getUTCFullYear();
    const hours = date.getUTCHours().toString().padStart(2, '0');
    const minutes = date.getUTCMinutes().toString().padStart(2, '0');
    const seconds = date.getUTCSeconds().toString().padStart(2, '0');
    const dateTimeStr = `${day}.${month}.${year} - ${hours}:${minutes}:${seconds} UTC`;
    
    const icon = lastPauseEvent.action === 'pause' ? '🔴' : '🟢';
    const action = lastPauseEvent.action === 'pause' ? 'Pause Euroz' : 'Unpause Euroz';

    message += `\n\n📜 *Last pause/unpause transaction:*\n`;
    message += `${icon} ${action} - ${dateTimeStr}\n`;
    message += `[View transaction in Etherscan](https://sepolia.etherscan.io/tx/${lastPauseEvent.hash})`;
  }

  // Show last auction creation
  if (lastAuctionEvent) {
    const date = new Date(lastAuctionEvent.timestamp);
    const day = date.getUTCDate().toString().padStart(2, '0');
    const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
    const year = date.getUTCFullYear();
    const hours = date.getUTCHours().toString().padStart(2, '0');
    const minutes = date.getUTCMinutes().toString().padStart(2, '0');
    const seconds = date.getUTCSeconds().toString().padStart(2, '0');
    const dateTimeStr = `${day}.${month}.${year} - ${hours}:${minutes}:${seconds} UTC`;

    message += `\n\n🎨 *Last auction created:*\n`;
    message += `🔨 Create Auction - ${dateTimeStr}\n`;
    message += `[View transaction in Etherscan](https://sepolia.etherscan.io/tx/${lastAuctionEvent.hash})`;
  }

  message += isSubscribed ? '\n\n🔔 You are subscribed' : '\n\n🔕 Not subscribed';
  message += '\n\n_Special thanks to @nastr_';
  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/subscribe/, (msg) => {
  const chatId = msg.chat.id;
  if (subscribers.has(chatId)) {
    bot.sendMessage(chatId, '✅ You are already subscribed!');
  } else {
    subscribers.add(chatId);
    saveSubscribers();
    bot.sendMessage(
      chatId,
      '🔔 *Subscribed!*\n\nYou will receive notifications when:\n• Contracts are unpaused\n• New auctions are created\n• zashapon.com comes back online\n• New Gachapon NFTs are minted',
      { parse_mode: 'Markdown' }
    );
    console.log(`New subscriber: ${chatId}. Total: ${subscribers.size}`);
  }
});

bot.onText(/\/unsubscribe/, (msg) => {
  const chatId = msg.chat.id;
  if (subscribers.has(chatId)) {
    subscribers.delete(chatId);
    saveSubscribers();
    bot.sendMessage(chatId, '🔕 Unsubscribed. You will no longer receive notifications.');
    console.log(`Unsubscribed: ${chatId}. Total: ${subscribers.size}`);
  } else {
    bot.sendMessage(chatId, "You weren't subscribed.");
  }
});

// Start
console.log('🤖 EUROZ Monitor Bot started!');
console.log(`Checking every ${CHECK_INTERVAL / 60000} minutes`);
console.log(`Monitoring owner: ${OWNER_ADDRESS}`);
console.log(`Monitoring auction bot: ${AUCTION_BOT_ADDRESS}`);
console.log(`Monitoring Gachapon NFT: ${GACHAPON_NFT_ADDRESS}`);

loadSubscribers();
loadLastBlock();
monitorLoop();
setInterval(monitorLoop, CHECK_INTERVAL);
