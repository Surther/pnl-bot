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

// ============ HELPERS ============
function alchemyBase(chain) {
    const isEth = chain !== "rbh";
    const key = isEth ? ALCHEMY_ETH_KEY : ALCHEMY_RBH_KEY;
    return isEth
        ? `https://eth-mainnet.g.alchemy.com/v2/${key}`
        : `https://robinhood-mainnet.g.alchemy.com/v2/${key}`;
}

function alchemyNftBase(chain) {
    const isEth = chain !== "rbh";
    const key = isEth ? ALCHEMY_ETH_KEY : ALCHEMY_RBH_KEY;
    return isEth
        ? `https://eth-mainnet.g.alchemy.com/nft/v3/${key}`
        : `https://robinhood-mainnet.g.alchemy.com/nft/v3/${key}`;
}

async function getTransfers(chain, params) {
    const res = await axios.post(alchemyBase(chain), {
        jsonrpc: "2.0", id: 1,
        method: "alchemy_getAssetTransfers",
        params: [params]
    });
    if (res.data.error) throw new Error(res.data.error.message);
    return res.data.result?.transfers || [];
}

// All NFT transfers, following pagination so nothing is missed
async function getAllTransfers(chain, params) {
    let all = [];
    let pageKey = undefined;
    for (let i = 0; i < 20; i++) {
        const p = { ...params, maxCount: "0x3e8" };
        if (pageKey) p.pageKey = pageKey;
        const res = await axios.post(alchemyBase(chain), {
            jsonrpc: "2.0", id: 1,
            method: "alchemy_getAssetTransfers",
            params: [p]
        });
        if (res.data.error) throw new Error(res.data.error.message);
        all = all.concat(res.data.result?.transfers || []);
        pageKey = res.data.result?.pageKey;
        if (!pageKey) break;
    }
    return all;
}

// ETH received by the wallet within one specific block, keyed by tx hash.
// Sale proceeds arrive as internal transfers, so we must ask per block.
async function ethReceivedInBlock(chain, wallet, blockNum) {
    const map = {};
    try {
        const transfers = await getTransfers(chain, {
            fromBlock: blockNum,
            toBlock: blockNum,
            toAddress: wallet,
            category: ["external", "internal"],
            withMetadata: false,
            excludeZeroValue: true,
            maxCount: "0x3e8"
        });
        for (const t of transfers) {
            if (!t.hash || !t.value) continue;
            const h = t.hash.toLowerCase();
            map[h] = (map[h] || 0) + Number(t.value);
        }
    } catch (e) {
        console.log(`Block ${blockNum} ETH-in lookup failed:`, e.message);
    }
    return map;
}

// Current floor price in ETH. Returns null when unavailable.
async function getFloorPrice(contractAddress, chain) {
    try {
        const res = await axios.get(`${alchemyNftBase(chain)}/getFloorPrice`, {
            params: { contractAddress }
        });
        const os = res.data?.openSea?.floorPrice;
        const lr = res.data?.looksRare?.floorPrice;
        const val = Number(os ?? lr ?? NaN);
        if (!isFinite(val) || val <= 0) return null;
        return val;
    } catch (e) {
        console.log("Floor price unavailable:", e.message);
        return null;
    }
}

// ============ CALCULATE PNL ============
async function calculatePnL(walletAddress, contractAddress, chain) {
    const wallet = walletAddress.toLowerCase();
    const provider = chain !== "rbh" ? ethProvider : rbhProvider;
    const ethPrice = await getEthPrice();

    // Every NFT movement in and out of this wallet for this collection
    const [nftIn, nftOut] = await Promise.all([
        getAllTransfers(chain, {
            toAddress: wallet,
            contractAddresses: [contractAddress],
            category: ["erc721", "erc1155"],
            withMetadata: false
        }),
        getAllTransfers(chain, {
            fromAddress: wallet,
            contractAddresses: [contractAddress],
            category: ["erc721", "erc1155"],
            withMetadata: false
        })
    ]);

    // Unique transactions so a multi-NFT purchase counts once
    const buyTxs = {};
    for (const t of nftIn) {
        if (t.hash) buyTxs[t.hash.toLowerCase()] = t.blockNum;
    }
    const sellTxs = {};
    for (const t of nftOut) {
        if (t.hash) sellTxs[t.hash.toLowerCase()] = t.blockNum;
    }

    // INVESTED: what the wallet actually paid, looked up per transaction.
    // Only counts when the wallet sent the tx, so airdrops and gifts stay at 0.
    let investedEth = 0;
    for (const hash of Object.keys(buyTxs)) {
        try {
            const tx = await provider.getTransaction(hash);
            if (tx && tx.from && tx.from.toLowerCase() === wallet && tx.value) {
                investedEth += parseFloat(ethers.formatEther(tx.value));
            }
        } catch (e) {
            console.log(`Buy tx ${hash} lookup failed:`, e.message);
        }
    }

    // REALIZED: proceeds from sales, queried block by block so internal
    // transfers from marketplaces are included.
    let realizedEth = 0;
    const sellBlocks = [...new Set(Object.values(sellTxs).filter(Boolean))];
    for (const block of sellBlocks) {
        const map = await ethReceivedInBlock(chain, wallet, block);
        for (const [hash, blockNum] of Object.entries(sellTxs)) {
            if (blockNum === block && map[hash]) realizedEth += map[hash];
        }
    }

    // HELD: what's still in the wallet
    const heldCount = Math.max(0, nftIn.length - nftOut.length);
    const floorEth = await getFloorPrice(contractAddress, chain);
    const floorKnown = floorEth !== null;
    const positionEth = floorKnown ? heldCount * floorEth : 0;

    const pnlEth = realizedEth + positionEth - investedEth;
    const pnlUsd = pnlEth * ethPrice;

    console.log(
        `PnL [${contractAddress}] buys=${Object.keys(buyTxs).length} sells=${Object.keys(sellTxs).length} ` +
        `invested=${investedEth.toFixed(4)}Ξ realized=${realizedEth.toFixed(4)}Ξ ` +
        `held=${heldCount} floor=${floorKnown ? floorEth : "unknown"} pnl=${pnlEth.toFixed(4)}Ξ`
    );

    return {
        pnlEth,
        pnlUsd,
        investedUsd: investedEth * ethPrice,
        positionUsd: positionEth * ethPrice,
        realizedUsd: realizedEth * ethPrice,
        pnlPercent: investedEth > 0 ? (pnlEth / investedEth) * 100 : null,
        buyCount: nftIn.length,
        sellCount: nftOut.length,
        heldCount,
        floorEth,
        floorKnown,
        ethPrice,
        isProfit: pnlUsd >= 0
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

    // Try local files - check fonts/ folder AND root folder
    const candidates = [
        { file: "Roboto-Regular.ttf", name: "PNL" },
        { file: "Roboto-Bold.ttf", name: "PNLBold" }
    ];

    for (const c of candidates) {
        const paths = [
            path.join(__dirname, "fonts", c.file),
            path.join(__dirname, c.file)
        ];
        for (const p of paths) {
            try {
                if (fs.existsSync(p)) {
                    GlobalFonts.registerFromPath(p, c.name);
                    if (c.name === "PNLBold") BOLD = "PNLBold"; else FONT = "PNL";
                    console.log(`Registered ${c.name} from ${p}`);
                    break;
                }
            } catch (e) {
                console.log(`Register failed for ${p}:`, e.message);
            }
        }
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

    // ===== BACKGROUND DARKNESS - tweak these three numbers =====
    const DARKNESS = 0.92;   // 0 = artwork untouched, 1 = solid black on the left
    const FADE_WIDTH = 0.75; // how far right the dark fade reaches (0.5 - 1.0)
    const GLOBAL_DIM = 0.25; // even dimming across the whole image (0 = off)

    // Even dim over everything
    if (GLOBAL_DIM > 0) {
        ctx.fillStyle = `rgba(0,0,0,${GLOBAL_DIM})`;
        ctx.fillRect(0, 0, W, H);
    }

    // Dark fade on the left so the text reads
    const overlay = ctx.createLinearGradient(0, 0, W * FADE_WIDTH, 0);
    overlay.addColorStop(0, `rgba(0,0,0,${DARKNESS})`);
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

    // Collection name
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold 48px ${BOLD}, sans-serif`;
    ctx.fillText(collectionName.toUpperCase(), 50, 190);

    // PnL box
    const isProfit = data.isProfit;
    const boxColor = isProfit ? "#00e88a" : "#ff4444";
    const pnlText = `${isProfit ? "+" : "-"}$${formatNum(Math.abs(data.pnlUsd))}`;

    const boxW = 620;
    const boxH = 100;
    const boxX = 50;
    const boxY = 215;

    ctx.fillStyle = boxColor;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 8);
    ctx.fill();

    ctx.fillStyle = isProfit ? "#000000" : "#ffffff";
    ctx.font = `bold 66px ${BOLD}, sans-serif`;
    ctx.fillText(pnlText, boxX + 24, boxY + 74);

    // Stats
    const statsY = 430;
    const gap = 58;

    ctx.font = `34px ${FONT}, sans-serif`;

    ctx.fillStyle = "#aaaaaa";
    ctx.fillText("PNL", 50, statsY);
    ctx.fillStyle = isProfit ? "#00e88a" : "#ff4444";
    const pctText = data.pnlPercent === null
        ? "—"
        : `${isProfit ? "+" : ""}${data.pnlPercent.toFixed(2)}%`;
    ctx.fillText(pctText, 260, statsY);

    ctx.fillStyle = "#aaaaaa";
    ctx.fillText("Invested", 50, statsY + gap);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`$${formatNum(data.investedUsd)}`, 260, statsY + gap);

    ctx.fillStyle = "#aaaaaa";
    ctx.fillText("Position", 50, statsY + gap * 2);
    ctx.fillStyle = "#ffffff";
    const posText = (!data.floorKnown && data.heldCount > 0)
        ? "N/A"
        : `$${formatNum(data.positionUsd)}`;
    ctx.fillText(posText, 260, statsY + gap * 2);

    // Watermark - bottom right, colored by profit/loss
    const wmText = `by @${username}`;
    ctx.font = `bold 26px ${BOLD}, sans-serif`;
    const wmWidth = ctx.measureText(wmText).width;
    const wmX = W - wmWidth - 40;
    const wmY = H - 34;

    // Dark backing so it stays readable over the artwork
    const padX = 16, padY = 10;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.roundRect(wmX - padX, wmY - 26 - padY + 6, wmWidth + padX * 2, 26 + padY * 2, 8);
    ctx.fill();

    ctx.fillStyle = isProfit ? "#00e88a" : "#ff4444";
    ctx.fillText(wmText, wmX, wmY);

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
