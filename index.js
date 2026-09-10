const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, AttachmentBuilder } = require("discord.js");
const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { ethers } = require("ethers");

// ============ CONFIG ============
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const ETH_RPC = "https://eth-mainnet.g.alchemy.com/v2/alch_plU6kpqJ7kP8onBcnnTOf";
const RBH_RPC = "https://robinhood-mainnet.g.alchemy.com/v2/alch_ZxPo1wF48uFzadUXFMUt9";
const ALCHEMY_ETH_KEY = "alch_plU6kpqJ7kP8onBcnnTOf";
const ALCHEMY_RBH_KEY = "alch_ZxPo1wF48uFzadUXFMUt9";

const BG_URL = "https://media.discordapp.net/attachments/1547542514498543638/1547548280236544050/ChatGPT_Image_Sep_10_2026_03_19_40_PM.png?ex=6aa3d226&is=6aa280a6&hm=f36e1609842b19c815d421157a2fc62e19f6541ac167aa7bb458bfecd5886218&=&format=webp&quality=lossless&width=1280&height=866";
const LOGO_URL = "https://media.discordapp.net/attachments/1547542514498543638/1547548281356419072/6118508735580802731.png?ex=6aa3d226&is=6aa280a6&hm=6b56b27be9e6fc7cf4ae227938a9dbf95a588a42212f8fe0c9f93704c713873a&=&format=webp&quality=lossless&width=1023&height=1024";

const ethProvider = new ethers.JsonRpcProvider(ETH_RPC);
const rbhProvider = new ethers.JsonRpcProvider(RBH_RPC);

const walletDB = {};

// ============ SLASH COMMANDS ============
const commands = [
    new SlashCommandBuilder()
        .setName("wallet")
        .setDescription("Link your wallet address")
        .addStringOption(opt =>
            opt.setName("address")
                .setDescription("Your ETH wallet address")
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName("profit")
        .setDescription("Calculate NFT PnL for a contract")
        .addStringOption(opt =>
            opt.setName("contract")
                .setDescription("NFT contract address")
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName("chain")
                .setDescription("Chain (eth or robinhood)")
                .setRequired(false)
                .addChoices(
                    { name: "Ethereum", value: "eth" },
                    { name: "Robinhood Chain", value: "rbh" }
                )
        ),
].map(cmd => cmd.toJSON());

async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("Slash commands registered!");
}

// ============ FETCH ETH PRICE ============
async function getEthPrice() {
    try {
        const res = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
        return res.data.ethereum.usd;
    } catch {
        return 2500;
    }
}

// ============ GET COLLECTION INFO ============
async function getCollectionInfo(contractAddress, chain) {
    const isEth = chain !== "rbh";
    const apiKey = isEth ? ALCHEMY_ETH_KEY : ALCHEMY_RBH_KEY;
    const baseUrl = isEth
        ? `https://eth-mainnet.g.alchemy.com/nft/v3/${apiKey}`
        : `https://robinhood-mainnet.g.alchemy.com/nft/v3/${apiKey}`;

    try {
        const res = await axios.get(`${baseUrl}/getContractMetadata`, {
            params: { contractAddress }
        });
        return {
            name: res.data.name || res.data.openSeaMetadata?.collectionName || "Unknown",
            image: res.data.openSeaMetadata?.imageUrl || null
        };
    } catch {
        return { name: "Unknown Collection", image: null };
    }
}

// ============ CALCULATE PNL ============
async function calculatePnL(walletAddress, contractAddress, chain) {
    const isEth = chain !== "rbh";
    const apiKey = isEth ? ALCHEMY_ETH_KEY : ALCHEMY_RBH_KEY;
    const baseUrl = isEth
        ? `https://eth-mainnet.g.alchemy.com/v2/${apiKey}`
        : `https://robinhood-mainnet.g.alchemy.com/v2/${apiKey}`;
    const provider = isEth ? ethProvider : rbhProvider;
    const ethPrice = await getEthPrice();

    // Get transfers TO wallet (buys)
    const buyRes = await axios.post(baseUrl, {
        jsonrpc: "2.0", id: 1,
        method: "alchemy_getAssetTransfers",
        params: [{
            toAddress: walletAddress,
            contractAddresses: [contractAddress],
            category: ["erc721", "erc1155"],
            withMetadata: true,
            maxCount: "0x64"
        }]
    });

    // Get transfers FROM wallet (sells)
    const sellRes = await axios.post(baseUrl, {
        jsonrpc: "2.0", id: 2,
        method: "alchemy_getAssetTransfers",
        params: [{
            fromAddress: walletAddress,
            contractAddresses: [contractAddress],
            category: ["erc721", "erc1155"],
            withMetadata: true,
            maxCount: "0x64"
        }]
    });

    const buys = buyRes.data.result?.transfers || [];
    const sells = sellRes.data.result?.transfers || [];

    let totalSpentEth = 0;
    let totalReceivedEth = 0;

    for (const tx of buys) {
        try {
            const txData = await provider.getTransaction(tx.hash);
            if (txData?.value) {
                totalSpentEth += parseFloat(ethers.formatEther(txData.value));
            }
        } catch {}
    }

    for (const tx of sells) {
        try {
            const txData = await provider.getTransaction(tx.hash);
            if (txData?.value) {
                totalReceivedEth += parseFloat(ethers.formatEther(txData.value));
            }
        } catch {}
    }

    const pnlEth = totalReceivedEth - totalSpentEth;
    const pnlUsd = pnlEth * ethPrice;
    const investedUsd = totalSpentEth * ethPrice;
    const positionUsd = totalReceivedEth * ethPrice;
    const pnlPercent = totalSpentEth > 0 ? (pnlEth / totalSpentEth) * 100 : 0;
    const heldCount = Math.max(0, buys.length - sells.length);

    return {
        pnlEth, pnlUsd, investedUsd, positionUsd,
        pnlPercent, buyCount: buys.length, sellCount: sells.length,
        heldCount, ethPrice, isProfit: pnlUsd >= 0
    };
}

// ============ FORMAT NUMBER ============
function formatNum(num) {
    const abs = Math.abs(num);
    if (abs >= 1000) return (num / 1000).toFixed(2) + "K";
    return num.toFixed(1);
}


// ============ LOAD FONTS ============
let FONT = "sans-serif";
let BOLD = "sans-serif";

const FONT_URLS = {
    regular: "https://raw.githubusercontent.com/googlefonts/roboto-classic/main/fonts/ttf/Roboto-Regular.ttf",
    bold: "https://raw.githubusercontent.com/googlefonts/roboto-classic/main/fonts/ttf/Roboto-Bold.ttf"
};

async function loadFonts() {
    // Debug: what's actually on disk
    try {
        console.log("App dir contents:", fs.readdirSync(__dirname).join(", "));
        const fdir = path.join(__dirname, "fonts");
        if (fs.existsSync(fdir)) {
            console.log("fonts/ contents:", fs.readdirSync(fdir).join(", "));
        } else {
            console.log("fonts/ folder does NOT exist");
        }
    } catch (e) {
        console.log("Dir read error:", e.message);
    }

    // Try local files first
    try {
        const reg = path.join(__dirname, "fonts", "Roboto-Regular.ttf");
        const bold = path.join(__dirname, "fonts", "Roboto-Bold.ttf");
        if (fs.existsSync(reg)) { GlobalFonts.registerFromPath(reg, "PNL"); FONT = "PNL"; }
        if (fs.existsSync(bold)) { GlobalFonts.registerFromPath(bold, "PNLBold"); BOLD = "PNLBold"; }
    } catch (e) {
        console.log("Local font register failed:", e.message);
    }

    // Fallback: download fonts at runtime
    if (FONT === "sans-serif") {
        for (const [key, url] of Object.entries(FONT_URLS)) {
            try {
                const res = await axios.get(url, { responseType: "arraybuffer", timeout: 15000 });
                const name = key === "bold" ? "PNLBold" : "PNL";
                GlobalFonts.register(Buffer.from(res.data), name);
                if (key === "bold") BOLD = "PNLBold"; else FONT = "PNL";
                console.log(`Downloaded font: ${name}`);
            } catch (e) {
                console.log(`Font download failed (${key}):`, e.message);
            }
        }
    }

    if (BOLD === "sans-serif" && FONT !== "sans-serif") BOLD = FONT;

    console.log("Registered families:", GlobalFonts.families.map(f => f.family).join(", ") || "(none)");
    console.log("Using FONT:", FONT, "| BOLD:", BOLD);
}

// ============ GENERATE IMAGE ============
async function generatePnLImage(data, collectionName, collectionImage, username) {
    const W = 1320, H = 740;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");

    // Background
    try {
        const bg = await loadImage(BG_URL);
        ctx.drawImage(bg, 0, 0, W, H);
    } catch {
        const grad = ctx.createLinearGradient(0, 0, W, H);
        grad.addColorStop(0, "#050a1a");
        grad.addColorStop(1, "#0a1628");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
    }

    // Dark overlay left side
    const overlay = ctx.createLinearGradient(0, 0, W * 0.65, 0);
    overlay.addColorStop(0, "rgba(0,0,0,0.82)");
    overlay.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = overlay;
    ctx.fillRect(0, 0, W, H);

    // Origins logo
    try {
        const logo = await loadImage(LOGO_URL);
        ctx.drawImage(logo, 48, 36, 48, 48);
    } catch {}

    // Origins text
    ctx.fillStyle = "#00f2f2";
    ctx.font = `bold 26px ${BOLD}, sans-serif`;
    ctx.fillText("origins", 108, 70);

    // Collection image (circle)
    if (collectionImage) {
        try {
            const img = await loadImage(collectionImage);
            ctx.save();
            ctx.beginPath();
            ctx.arc(96, 150, 44, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(img, 52, 106, 88, 88);
            ctx.restore();
        } catch {}
    }

    // Collection name
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold 72px ${BOLD}, sans-serif`;
    ctx.fillText(collectionName.toUpperCase(), 50, 240);

    // PnL box
    const isProfit = data.isProfit;
    const boxColor = isProfit ? "#00e88a" : "#ff4444";
    const pnlText = `${isProfit ? "+" : "-"}$${formatNum(Math.abs(data.pnlUsd))}`;

    const boxW = 620;
    const boxH = 100;
    const boxX = 50;
    const boxY = 260;

    ctx.fillStyle = boxColor;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 8);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.font = `bold 66px ${BOLD}, sans-serif`;
    ctx.fillText(pnlText, boxX + 24, boxY + 74);

    // Stats
    const statsY = 430;
    const gap = 58;

    ctx.font = `34px ${FONT}, sans-serif`;

    ctx.fillStyle = "#aaaaaa";
    ctx.fillText("PNL", 50, statsY);
    ctx.fillStyle = isProfit ? "#00e88a" : "#ff4444";
    ctx.fillText(`${isProfit ? "+" : ""}${data.pnlPercent.toFixed(2)}%`, 260, statsY);

    ctx.fillStyle = "#aaaaaa";
    ctx.fillText("Invested", 50, statsY + gap);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`$${formatNum(data.investedUsd)}`, 260, statsY + gap);

    ctx.fillStyle = "#aaaaaa";
    ctx.fillText("Position", 50, statsY + gap * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`$${formatNum(data.positionUsd)}`, 260, statsY + gap * 2);

    // Watermark
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = `22px ${FONT}, sans-serif`;
    ctx.fillText(`by @${username}`, W - 200, H - 28);

    return canvas.toBuffer("image/png");
}

// ============ BOT ============
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
    console.log(`PNL Bot logged in as ${client.user.tag}`);
    await loadFonts();
    await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "wallet") {
        const address = interaction.options.getString("address");
        if (!ethers.isAddress(address)) {
            return interaction.reply({ content: "❌ Invalid wallet address!", ephemeral: true });
        }
        walletDB[interaction.user.id] = address;
        return interaction.reply({ content: `✅ Wallet linked: \`${address}\``, ephemeral: true });
    }

    if (interaction.commandName === "profit") {
        const contract = interaction.options.getString("contract");
        const chain = interaction.options.getString("chain") || "eth";
        const wallet = walletDB[interaction.user.id];

        if (!wallet) {
            return interaction.reply({ content: "❌ No wallet linked! Use `/wallet` first.", ephemeral: true });
        }
        if (!ethers.isAddress(contract)) {
            return interaction.reply({ content: "❌ Invalid contract address!", ephemeral: true });
        }

        await interaction.deferReply();

        try {
            const [pnlData, collectionInfo] = await Promise.all([
                calculatePnL(wallet, contract, chain),
                getCollectionInfo(contract, chain)
            ]);

            const imageBuffer = await generatePnLImage(
                pnlData,
                collectionInfo.name,
                collectionInfo.image,
                interaction.user.username
            );

            const attachment = new AttachmentBuilder(imageBuffer, { name: "pnl.png" });
            await interaction.editReply({ files: [attachment] });
        } catch (e) {
            console.error(e);
            await interaction.editReply("❌ Error calculating PnL. Check the contract address and try again.");
        }
    }
});

client.login(BOT_TOKEN);
