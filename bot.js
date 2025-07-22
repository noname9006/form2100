require('dotenv').config();
const cron = require('node-cron');
const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const { google } = require('googleapis');

// Import ticket system
const TicketSender = require('./sender.js');
let ticketSender;

const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ] 
});

// Use GoogleAuth instead of JWT
const auth = new google.auth.GoogleAuth({
  keyFile: './please-465416-21b3ba49f846.json', // Your JSON file pathit 
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'Processed';
const ROLE_ID = process.env.ROLE_ID;
const EXPORT_CHANNELID = process.env.EXPORT_CHANNELID;
const ADD_TXT = process.env.ADD_TXT || '';

// Google Sheets color definitions
const COLORS = {
  LIGHT_RED: { red: 1, green: 0.4, blue: 0.4 }, // Lighter red
  LIGHT_ORANGE: { red: 1, green: 0.8, blue: 0.4 }, // Light orange for duplicates
  VERY_LIGHT_AMBER: { red: 1, green: 0.9, blue: 0.7 }, // Very light amber
  VERY_LIGHT_BLUE: { red: 0.8, green: 0.9, blue: 1 }, // Very light blue
};

async function getSheetIdByName(sheetName) {
  console.log(`🔍 Looking for sheet: "${sheetName}"`);
  const res = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
  });
  const sheet = res.data.sheets.find(s => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet/tab "${sheetName}" not found`);
  console.log(`✅ Found sheet "${sheetName}" with ID: ${sheet.properties.sheetId}`);
  return sheet.properties.sheetId;
}

function getColorRequest(rowIndex, color, sheetId) {
  return {
    repeatCell: {
      range: {
        sheetId: sheetId,
        startRowIndex: rowIndex,
        endRowIndex: rowIndex + 1,
        startColumnIndex: 0, // Column A (0-indexed)
        endColumnIndex: 7,    // Column G (0-indexed, so 7 means up to G)
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: COLORS[color],
        },
      },
      fields: 'userEnteredFormat.backgroundColor',
    },
  };
}

async function getSheetRows() {
  console.log(`📊 Fetching rows from ${SHEET_NAME}...`);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:L`,
  });
  const rows = res.data.values || [];
  console.log(`✅ Found ${rows.length} rows of data`);
  return rows;
}

async function getSheetColors() {
  console.log(`🎨 Fetching cell colors...`);
  const res = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    ranges: [`${SHEET_NAME}!A2:L`],
    includeGridData: true,
  });
  const colorRows = res.data.sheets[0].data[0].rowData || [];
  console.log(`✅ Retrieved colors for ${colorRows.length} rows`);
  return colorRows;
}

async function userHasRole(guild, userId, roleId) {
  try {
    const member = await guild.members.fetch(userId);
    const hasRole = member.roles.cache.has(roleId);
    console.log(`👤 User ${userId} has role ${roleId}: ${hasRole}`);
    return hasRole;
  } catch (error) {
    console.log(`❌ Error checking role for user ${userId}: ${error.message}`);
    return false;
  }
}

function isColor(cell, color) {
  if (!cell || !cell.userEnteredFormat || !cell.userEnteredFormat.backgroundColor) return false;
  const c = cell.userEnteredFormat.backgroundColor;
  const ref = COLORS[color];
  // Simple color match (tolerance for float rounding)
  return (
    Math.abs((c.red || 0) - ref.red) < 0.05 &&
    Math.abs((c.green || 0) - ref.green) < 0.05 &&
    Math.abs((c.blue || 0) - ref.blue) < 0.05
  );
}

async function processSheetAndExport() {
  console.log('\n🚀 Starting sheet processing...');
  
  const sheetId = await getSheetIdByName(SHEET_NAME);
  const guild = client.guilds.cache.first();
  const channel = await client.channels.fetch(EXPORT_CHANNELID);

  // 1. Get all rows and their colors
  const rows = await getSheetRows();
  const colorRows = await getSheetColors();

  // Step 1: Count all wallet addresses
  const evmAddresses = rows.map(row => row[4]);
  const evmCount = {};
  evmAddresses.forEach(addr => {
    if (addr) evmCount[addr] = (evmCount[addr] || 0) + 1;
  });
  const duplicateEvm = Object.keys(evmCount).filter(addr => evmCount[addr] > 1);

  // Step 2: Mark ALL rows with duplicate wallet addresses (column E)
  let requests = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const evmAddress = row[4];
    const colorCells = colorRows[i].values || [];
    // Only mark if not already colored
    const alreadyColored = colorCells[4] && (isColor(colorCells[4], 'LIGHT_ORANGE') || isColor(colorCells[4], 'LIGHT_RED'));
    if (duplicateEvm.includes(evmAddress) && !alreadyColored) {
      requests.push({
        repeatCell: {
          range: {
            sheetId: sheetId,
            startRowIndex: i + 1,
            endRowIndex: i + 2,
            startColumnIndex: 4, // Column E
            endColumnIndex: 5,   // Column E
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: COLORS.LIGHT_ORANGE,
            },
          },
          fields: 'userEnteredFormat.backgroundColor',
        },
      });
    }
  }

  // 2. First pass: Check for duplicates and collect valid entries BEFORE coloring
  console.log('\n🔍 Checking for duplicates and collecting valid entries...');
  let seenUserIds = new Set();
  let seenEvmAddresses = new Set();
  let duplicateCount = 0;
  let validEntriesForExport = []; // Collect valid entries before coloring
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const userId = row[3]; // Column D
    const evmAddress = row[4]; // Column E
    const colorCells = colorRows[i].values || [];
    
    console.log(`\n📝 Checking row ${i + 2}: UserID ${userId}, EVM ${evmAddress}`);
    
    // Check if any cell in the row is already colored
    const hasColoredCell = colorCells.some(cell => 
      isColor(cell, 'LIGHT_ORANGE') || isColor(cell, 'LIGHT_RED') || 
      isColor(cell, 'VERY_LIGHT_AMBER') || isColor(cell, 'VERY_LIGHT_BLUE')
    );
    
    if (hasColoredCell) {
      console.log(`🚫 Row ${i + 2}: Has colored cells, skipping`);
      continue;
    }
    
    // Check if UserID already exists
    if (seenUserIds.has(userId)) {
      console.log(`🟠 Row ${i + 2}: Duplicate entry - UserID exists: true`);
      // Color only the specific cell that is duplicate (UserID)
      requests.push({
        repeatCell: {
          range: {
            sheetId: sheetId,
            startRowIndex: i + 1,
            endRowIndex: i + 2,
            startColumnIndex: 3, // Column D
            endColumnIndex: 4,   // Column D
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: COLORS.LIGHT_ORANGE,
            },
          },
          fields: 'userEnteredFormat.backgroundColor',
        },
      });
      duplicateCount++;
    } else {
      console.log(`✅ Row ${i + 2}: Not a duplicate - adding to valid entries`);
      seenUserIds.add(userId);
      seenEvmAddresses.add(evmAddress);
      // Add to valid entries for export (before role check)
      validEntriesForExport.push({ rowIndex: i + 1, evmAddress: evmAddress, userId: userId });
    }
  }
  
  console.log(`\n📊 Duplicate Summary: ${duplicateCount} rows have duplicate cells colored LIGHT_ORANGE`);
  console.log(`📊 Valid entries collected: ${validEntriesForExport.length}`);

  // 3. Second pass: Check for role and remove invalid entries from export list
  console.log('\n🔍 Checking roles and removing invalid entries from export...');
  let lightRedCount = 0;
  let finalValidEntries = [];
  let unverifiedMembers = 0;
  
  for (let entry of validEntriesForExport) {
    const i = entry.rowIndex - 1; // Convert back to array index
    const userId = entry.userId;
    
    console.log(`\n📝 Checking role for row ${i + 2}: UserID ${userId}`);
    
    // Check for role - color LIGHT_RED if user does NOT have the role
    if (!(await userHasRole(guild, userId, ROLE_ID))) {
      console.log(`🔴 Row ${i + 2}: User does NOT have role - coloring UserID cell (column D) LIGHT_RED`);
      requests.push({
        repeatCell: {
          range: {
            sheetId: sheetId,
            startRowIndex: i + 1,
            endRowIndex: i + 2,
            startColumnIndex: 3, // Column D
            endColumnIndex: 4,   // Column D
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: COLORS.LIGHT_RED,
            },
          },
          fields: 'userEnteredFormat.backgroundColor',
        },
      });
      lightRedCount++;
      unverifiedMembers++;
      // Remove from export list
      console.log(`🚫 Row ${i + 2}: Removed from export (no role)`);
    } else {
      console.log(`✅ Row ${i + 2}: User has role - keeping in export list`);
      finalValidEntries.push(entry);
    }
  }
  
  console.log(`\n📊 Role Summary: ${lightRedCount} UserID cells colored LIGHT_RED`);
  console.log(`📊 Final valid entries for export: ${finalValidEntries.length}`);
  
  if (requests.length > 0) {
    console.log(`🎨 Applying ${requests.length} color changes...`);
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
    console.log(`✅ Color changes applied successfully`);
  }

  // 4. Export the collected valid entries
  console.log('\n📦 Exporting collected valid entries...');
  let exportValues = [];
  let exportRowIndices = [];

  // Step 1: Count all user IDs
  const userIds = rows.map(row => row[3]);
  const userIdCount = {};
  userIds.forEach(id => {
    if (id) userIdCount[id] = (userIdCount[id] || 0) + 1;
  });
  const duplicateUserIds = Object.keys(userIdCount).filter(id => userIdCount[id] > 1);

  // Only export entries that are NOT duplicates in column E or D
  for (let entry of finalValidEntries) {
    const row = rows[entry.rowIndex - 1];
    const evmAddress = row[4];
    const userId = row[3];
    if (!duplicateEvm.includes(evmAddress) && !duplicateUserIds.includes(userId)) {
      console.log(`📄 Row ${entry.rowIndex}: Adding ${evmAddress} to export list`);
      exportValues.push(entry.evmAddress);
      exportRowIndices.push(entry.rowIndex);
    } else {
      console.log(`⏭️ Row ${entry.rowIndex}: Skipped from export (duplicate wallet or userID: ${evmAddress}, ${userId})`);
    }
  }

  console.log(`\n📊 Export Summary: ${exportValues.length} addresses ready for export`);

  // Find the last cell with export color to determine next color
  let lastExportColor = null;
  for (let i = colorRows.length - 1; i >= 0; i--) {
    const colorCells = colorRows[i].values || [];
    const hasAmber = colorCells.some(cell => isColor(cell, 'VERY_LIGHT_AMBER'));
    const hasBlue = colorCells.some(cell => isColor(cell, 'VERY_LIGHT_BLUE'));
    if (hasAmber) {
      lastExportColor = 'VERY_LIGHT_AMBER';
      console.log(`🎨 Found last export color: VERY_LIGHT_AMBER in row ${i + 2}`);
      break;
    } else if (hasBlue) {
      lastExportColor = 'VERY_LIGHT_BLUE';
      console.log(`🎨 Found last export color: VERY_LIGHT_BLUE in row ${i + 2}`);
      break;
    }
  }
  // Determine which color to use for new exports
  let currentExportColor;
  if (lastExportColor === 'VERY_LIGHT_AMBER') {
    currentExportColor = 'VERY_LIGHT_BLUE'; // Use blue if last was amber
    console.log(`🎨 Using VERY_LIGHT_BLUE for new exports (last export was amber)`);
  } else if (lastExportColor === 'VERY_LIGHT_BLUE') {
    currentExportColor = 'VERY_LIGHT_AMBER'; // Use amber if last was blue
    console.log(`🎨 Using VERY_LIGHT_AMBER for new exports (last export was blue)`);
  } else {
    currentExportColor = 'VERY_LIGHT_AMBER'; // Default to amber if no previous exports
    console.log(`🎨 Using VERY_LIGHT_AMBER for new exports (no previous exports found)`);
  }

  // 5. Send txt file to channel
  if (exportValues.length > 0) {
    console.log(`📤 Sending ${exportValues.length} addresses to Discord...`);
    const buffer = Buffer.from(exportValues.join('\n'), 'utf-8');
    const attachment = new AttachmentBuilder(buffer, { name: 'export.txt' });
    await channel.send({ files: [attachment] });
    console.log(`✅ File sent to Discord channel`);

    // Send summary message
    const now = new Date();
    const utcString = now.toISOString().replace('T', ' ').replace(/\..+/, '');
    const processedCount = rows.length;
    const userIdDupCount = duplicateUserIds.length;
    const walletDupCount = duplicateEvm.length;
    const exportedCount = exportValues.length;
    const summaryMsg =
      `**Export Summary**\n` +
      `Date (UTC): ${utcString}\n` +
      `Entries processed: ${processedCount}\n` +
      `UserID duplicates: ${userIdDupCount}\n` +
      `Wallet duplicates: ${walletDupCount}\n` +
      `Unverified members: ${unverifiedMembers}\n` +
      `Exported EVM addresses: ${exportedCount}` +
      (ADD_TXT ? `\n\n${ADD_TXT}` : '');
    await channel.send(summaryMsg);
  } else {
    console.log(`ℹ️ No fresh addresses to export`);
  }

  // 6. Color all exported rows with the determined color
  if (exportRowIndices.length > 0) {
    console.log('\n🎨 Coloring exported rows...');
    let requests2 = [];
    
    console.log(`🎨 Coloring all ${exportRowIndices.length} exported rows with ${currentExportColor} (columns A-G)`);
    
    for (let idx of exportRowIndices) {
      requests2.push(getColorRequest(idx, currentExportColor, sheetId));
    }
    
    console.log(`📊 Coloring Summary: All ${exportRowIndices.length} rows colored ${currentExportColor}`);
    
    if (requests2.length > 0) {
      console.log(`🎨 Applying ${requests2.length} color changes...`);
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: requests2 } });
      console.log(`✅ Color changes applied successfully`);
    }
  }

  console.log('\n✅ Sheet processing completed successfully!');
}

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  console.log(`📋 Processing sheet: ${SHEET_ID}`);
  console.log(`🎯 Target tab: ${SHEET_NAME}`);
  console.log(`👥 Role ID: ${ROLE_ID}`);
  console.log(`📤 Export channel: ${EXPORT_CHANNELID}`);
  console.log(`⏰ Cron schedule: ${process.env.CRON_SCHEDULE}`);
  
  // Initialize the ticket sender system
  try {
    ticketSender = new TicketSender(client);
    ticketSender.init();
    console.log('🎫 Ticket system initialized successfully');
    
    // Log ticket system configuration
    console.log(`🗂️ Ticket category: ${process.env.TICKET_CAT}`);
    console.log(`⏰ Close hours: ${parseFloat(process.env.CLOSE_HOURS) || 1}`);
    console.log(`🔧 Debug mode: ${process.env.DEBUG_MODE || 'false'}`);
  } catch (error) {
    console.error('❌ Failed to initialize ticket system:', error);
  }
  
  // Use cron schedule from .env
  cron.schedule(process.env.CRON_SCHEDULE, async () => {
    console.log('\n⏰ Scheduled run triggered...');
    await processSheetAndExport();
  });
});

client.login(process.env.DISCORD_TOKEN);