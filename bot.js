require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

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
      console.log(`Loaded last block: ${lastCheckedBlock}, auction block: ${lastCheckedAuctionBlock}`);
      
      // If lastAuctionEvent was null in file, save the initial one
      if (!data.lastAuctionEvent) {
        saveLastBlock(null, null, null, INITIAL_AUCTION_EVENT);
      }
    } else {
      // Use initial events
      lastPauseEvent = INITIAL_PAUSE_EVENT;
      lastAuctionEvent = INITIAL_AUCTION_EVENT;
    }
  } catch (err) {
    console.error('Error loading last block:', err.message);
    lastPauseEvent = INITIAL_PAUSE_EVENT;
    lastAuctionEvent = INITIAL_AUCTION_EVENT;
  }
}

// Save last checked block
function saveLastBlock(block, pauseEvent = null, auctionBlock = null, auctionEvent = null) {
  try {
    if (block !== null) lastCheckedBlock = block;
    if (pauseEvent) lastPauseEvent = pauseEvent;
    if (auctionBlock !== null) lastCheckedAuctionBlock = auctionBlock;
    if (auctionEvent) lastAuctionEvent = auctionEvent;
    
    fs.writeFileSync(LAST_BLOCK_FILE, JSON.stringify({ 
      block: lastCheckedBlock, 
      lastPauseEvent,
      auctionBlock: lastCheckedAuctionBlock,
      lastAuctionEvent
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

  if (contractInfo.pauseMethod === 'paused') {
    return await contract.paused();
  } else if (contractInfo.pauseMethod === 'pausableToken') {
    const pausableAddr = await contract.pausableToken();
    const pausableContract = new ethers.Contract(pausableAddr, PAUSED_ABI, provider);
    return await pausableContract.paused();
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

async function monitorLoop() {
  console.log('Checking contract status...');
  const status = await checkAllContracts();

  // Check for changes
  let changed = false;
  let unpaused = false;
  for (const key of Object.keys(status)) {
    if (lastStatus[key] !== null && lastStatus[key] !== status[key]) {
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

  lastStatus = status;
  console.log('Status:', status, `| Subscribers: ${subscribers.size}`);

  // Check owner transactions
  await checkOwnerTransactions();
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
      `• Auction creation events`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const status = await checkAllContracts();
  const isSubscribed = subscribers.has(chatId);
  let message = formatStatus(status);

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
      '🔔 *Subscribed!*\n\nYou will receive a notification when contracts are unpaused.',
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

loadSubscribers();
loadLastBlock();
monitorLoop();
setInterval(monitorLoop, CHECK_INTERVAL);
