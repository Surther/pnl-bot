const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, AttachmentBuilder,
        EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
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

// Tokens that count as ETH for buying and selling NFTs
const ETH_EQUIV_TOKENS = new Set([
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
    "0x0000000000a39bb272e79075ade125fd351887ac", // Blur Pool (BETH)
].map(a => a.toLowerCase()));

// userId -> [address, ...]
let walletDB = {};

const DATA_DIR = process.env.DATA_DIR || __dirname;
const WALLET_FILE = require("path").join(DATA_DIR, "wallets.json");

function loadWallets() {
    try {
        if (require("fs").existsSync(WALLET_FILE)) {
            walletDB = JSON.parse(require("fs").readFileSync(WALLET_FILE, "utf8"));
            const count = Object.values(walletDB).reduce((n, a) => n + a.length, 0);
            console.log(`Loaded ${count} wallet(s) for ${Object.keys(walletDB).length} user(s)`);
        }
    } catch (e) {
        console.log("Wallet load failed:", e.message);
        walletDB = {};
    }
}

function saveWallets() {
    try {
        require("fs").writeFileSync(WALLET_FILE, JSON.stringify(walletDB, null, 2));
    } catch (e) {
        console.log("Wallet save failed:", e.message);
    }
}

function getWallets(userId) {
    return walletDB[userId] || [];
}

// ============ SLASH COMMANDS ============
const commands = [
    new SlashCommandBuilder()
        .setName("help")
        .setDescription("How this bot works"),

    new SlashCommandBuilder()
        .setName("wallets")
        .setDescription("Manage your linked wallets")
        .addSubcommand(sub =>
            sub.setName("add")
                .setDescription("Link a wallet")
                .addStringOption(opt =>
                    opt.setName("address")
                        .setDescription("Wallet address (0x...)")
                        .setRequired(true))
        )
        .addSubcommand(sub =>
            sub.setName("remove")
                .setDescription("Unlink a wallet")
                .addStringOption(opt =>
                    opt.setName("address")
                        .setDescription("Wallet address to unlink")
                        .setRequired(true))
        )
        .addSubcommand(sub =>
            sub.setName("list")
                .setDescription("Show your linked wallets")
        ),

    new SlashCommandBuilder()
        .setName("debug")
        .setDescription("Show the raw data behind a PnL calculation")
        .addStringOption(opt =>
            opt.setName("contract")
                .setDescription("NFT contract address")
                .setRequired(true))
        .addStringOption(opt =>
            opt.setName("chain")
                .setDescription("Defaults to Ethereum")
                .setRequired(false)
                .addChoices(
                    { name: "Ethereum", value: "eth" },
                    { name: "Robinhood Chain", value: "rbh" }
                )),

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
                .setDescription("Defaults to Ethereum")
                .setRequired(false)
                .addChoices(
                    { name: "Ethereum", value: "eth" },
                    { name: "Robinhood Chain", value: "rbh" }
                )
        ),
].map(cmd => cmd.toJSON());

async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
    const guildId = process.env.GUILD_ID;

    try {
        if (guildId) {
            // Guild commands appear immediately
            await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commands });
            console.log(`Registered ${commands.length} commands to guild ${guildId}`);

            // Clear the global set so old commands stop showing alongside them
            await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
            console.log("Cleared global commands");
        } else {
            // Global commands can take up to an hour to appear
            await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
            console.log(`Registered ${commands.length} commands globally - may take up to 1 hour to show`);
        }
        console.log("Commands:", commands.map(c => "/" + c.name).join(", "));
    } catch (e) {
        console.error("Command registration failed:", e.message);
    }
}

// ============ FETCH ETH PRICE ============
let cachedPrice = null;
let cachedAt = 0;

async function getEthPrice() {
    // Cache for 5 minutes so repeated commands do not hammer the APIs
    if (cachedPrice && Date.now() - cachedAt < 5 * 60 * 1000) return cachedPrice;

    const sources = [
        async () => {
            const r = await axios.get("https://api.coinbase.com/v2/prices/ETH-USD/spot", { timeout: 8000 });
            return Number(r.data?.data?.amount);
        },
        async () => {
            const r = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { timeout: 8000 });
            return Number(r.data?.ethereum?.usd);
        },
        async () => {
            const r = await axios.get("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT", { timeout: 8000 });
            return Number(r.data?.price);
        }
    ];

    for (const fetchPrice of sources) {
        try {
            const price = await fetchPrice();
            if (isFinite(price) && price > 0) {
                cachedPrice = price;
                cachedAt = Date.now();
                return price;
            }
        } catch (e) {
            // try the next source
        }
    }

    console.log("All ETH price sources failed - using last known or 2500");
    return cachedPrice || 2500;
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

// Value moved to or from the wallet within one specific block, keyed by tx hash.
// Sale proceeds arrive as internal transfers, and offer-based sales pay in
// WETH or Blur Pool, so all three are counted.
async function valueMovedInBlock(chain, wallet, blockNum, direction) {
    const map = {};

    const base = {
        fromBlock: blockNum,
        toBlock: blockNum,
        withMetadata: false,
        excludeZeroValue: true,
        maxCount: "0x3e8"
    };
    if (direction === "in") base.toAddress = wallet;
    else base.fromAddress = wallet;

    // Each category is queried on its own. Some chains do not support
    // internal transfers, and one unsupported category must not discard
    // the results from the others.
    for (const cat of ["external", "internal", "erc20"]) {
        try {
            const transfers = await getTransfers(chain, {
                ...base,
                category: [cat]
            });
            for (const t of transfers) {
                if (!t.hash || !t.value) continue;

                // Only WETH-style tokens count from the erc20 category
                if (cat === "erc20") {
                    const token = t.rawContract?.address?.toLowerCase();
                    if (!token || !ETH_EQUIV_TOKENS.has(token)) continue;
                }

                const h = t.hash.toLowerCase();
                map[h] = (map[h] || 0) + Number(t.value);
            }
        } catch (e) {
            console.log(`Block ${blockNum} ${cat}-${direction} skipped: ${e.message}`);
        }
    }

    return map;
}

// Net ETH change for a wallet across one block. Works on any EVM chain and
// cannot overcount, because it measures the wallet itself rather than trying
// to interpret how a marketplace routed the payment.
async function balanceDelta(provider, wallet, blockNumHex) {
    try {
        const block = parseInt(blockNumHex, 16);
        if (!isFinite(block) || block <= 0) return 0;
        const [before, after] = await Promise.all([
            provider.getBalance(wallet, block - 1),
            provider.getBalance(wallet, block)
        ]);
        return parseFloat(ethers.formatEther(after - before));
    } catch (e) {
        console.log(`Balance delta failed at ${blockNumHex}:`, e.message);
        return 0;
    }
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
async function calcForWallet(walletAddress, contractAddress, chain) {
    const wallet = walletAddress.toLowerCase();
    const provider = chain !== "rbh" ? ethProvider : rbhProvider;
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

    // INVESTED: what was paid to acquire these NFTs.
    // First choice is ETH that left the wallet in that transaction. If none is
    // found, fall back to the value carried by the transaction itself, which
    // covers purchases routed through a marketplace or another sender.
    let investedEth = 0;
    const buyBlocks = [...new Set(Object.values(buyTxs).filter(Boolean))];
    const ethOutByHash = {};
    for (const block of buyBlocks) {
        const map = await valueMovedInBlock(chain, wallet, block, "out");
        for (const [h, v] of Object.entries(map)) {
            ethOutByHash[h] = (ethOutByHash[h] || 0) + v;
        }
    }

    for (const hash of Object.keys(buyTxs)) {
        let paid = ethOutByHash[hash] || 0;
        let source = "wallet-out";

        // Fall back to how much the wallet's balance actually dropped.
        // Includes gas, so it is only used when nothing else is available.
        if (paid === 0) {
            const delta = await balanceDelta(provider, wallet, buyTxs[hash]);
            if (delta < 0) {
                paid = Math.abs(delta);
                source = "balance-delta";
            }
        }

        investedEth += paid;
        console.log(`  buy ${hash.slice(0, 10)} paid=${paid}Ξ (${source})`);
    }

    // REALIZED: proceeds from sales, queried block by block so internal
    // transfers from marketplaces are included.
    let realizedEth = 0;
    const sellBlocks = [...new Set(Object.values(sellTxs).filter(Boolean))];
    for (const block of sellBlocks) {
        const map = await valueMovedInBlock(chain, wallet, block, "in");
        for (const [hash, blockNum] of Object.entries(sellTxs)) {
            if (blockNum !== block) continue;

            let got = map[hash] || 0;
            let source = "wallet-in";

            // Nothing detected arriving. Measure how much the wallet's balance
            // actually grew in this block. Never uses the buyer's transaction
            // value, which would include the rest of a bulk purchase.
            if (got === 0) {
                const delta = await balanceDelta(provider, wallet, block);
                if (delta > 0) {
                    got = delta;
                    source = "balance-delta";
                }
            }

            realizedEth += got;
            console.log(`  sell ${hash.slice(0, 10)} received=${got}Ξ (${source})`);
        }
    }

    // HELD: what's still in this wallet
    const heldCount = Math.max(0, nftIn.length - nftOut.length);

    console.log(
        `  wallet ${wallet.slice(0, 8)} invested=${investedEth.toFixed(4)}Ξ ` +
        `realized=${realizedEth.toFixed(4)}Ξ held=${heldCount}`
    );

    return { investedEth, realizedEth, heldCount, buyCount: nftIn.length, sellCount: nftOut.length };
}

// Runs every linked wallet and adds the results together
async function calculatePnL(wallets, contractAddress, chain) {
    const ethPrice = await getEthPrice();

    let investedEth = 0, realizedEth = 0, heldCount = 0, buyCount = 0, sellCount = 0;

    for (const w of wallets) {
        try {
            const r = await calcForWallet(w, contractAddress, chain);
            investedEth += r.investedEth;
            realizedEth += r.realizedEth;
            heldCount += r.heldCount;
            buyCount += r.buyCount;
            sellCount += r.sellCount;
        } catch (e) {
            console.log(`Wallet ${w} failed:`, e.message);
        }
    }

    const floorEth = await getFloorPrice(contractAddress, chain);
    const floorKnown = floorEth !== null;
    const positionEth = floorKnown ? heldCount * floorEth : 0;

    const pnlEth = realizedEth + positionEth - investedEth;
    const pnlUsd = pnlEth * ethPrice;

    console.log(
        `PnL [${contractAddress}] wallets=${wallets.length} buys=${buyCount} sells=${sellCount} ` +
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
        buyCount,
        sellCount,
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

    // Stats - rows adapt to whether the position is open, closed, or mixed
    const rows = [];

    rows.push({
        label: "PNL",
        value: data.pnlPercent === null
            ? "—"
            : `${isProfit ? "+" : ""}${data.pnlPercent.toFixed(2)}%`,
        color: isProfit ? "#00e88a" : "#ff4444"
    });

    rows.push({
        label: "Invested",
        value: `$${formatNum(data.investedUsd)}`,
        color: "#ffffff"
    });

    // Sold: proceeds already banked
    if (data.realizedUsd > 0) {
        rows.push({
            label: "Sold",
            value: `$${formatNum(data.realizedUsd)}`,
            color: "#ffffff"
        });
    }

    // Position: only meaningful while still holding
    if (data.heldCount > 0) {
        rows.push({
            label: "Position",
            value: data.floorKnown ? `$${formatNum(data.positionUsd)}` : "N/A",
            color: "#ffffff"
        });
    } else if (data.realizedUsd <= 0) {
        // Nothing held and nothing sold - keep a row so the layout isn't bare
        rows.push({ label: "Position", value: "$0.0", color: "#ffffff" });
    }

    const gap = 58;
    const statsY = 430 - Math.max(0, rows.length - 3) * gap;

    ctx.font = `34px ${FONT}, sans-serif`;

    rows.forEach((row, i) => {
        const y = statsY + gap * i;
        ctx.fillStyle = "#aaaaaa";
        ctx.fillText(row.label, 50, y);
        ctx.fillStyle = row.color;
        ctx.fillText(row.value, 260, y);
    });

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
    loadWallets();
    await loadFonts();
    await registerCommands();
});

// ============ HELP TEXT ============
function buildHelpEmbed() {
    return new EmbedBuilder()
        .setTitle("Origins PNL")
        .setColor("#00f2f2")
        .setDescription(
            "Tracks what you made or lost on an NFT collection and draws it as a card you can share."
        )
        .addFields(
            {
                name: "Getting started",
                value:
                    "`/wallets add` — link a wallet\n" +
                    "`/profit` — paste a collection's contract address to see your PnL"
            },
            {
                name: "Managing wallets",
                value:
                    "`/wallets list` — see everything you've linked\n" +
                    "`/wallets remove` — unlink one\n\n" +
                    "Link as many as you like. `/profit` adds them all together, so a collection " +
                    "you bought on one wallet and sold from another still reads correctly."
            },
            {
                name: "Chains",
                value:
                    "Leave the chain option blank and it uses **Ethereum**. " +
                    "Pick **Robinhood Chain** from the dropdown for anything on that network — " +
                    "querying the wrong chain returns empty or nonsense numbers."
            },
            {
                name: "How the numbers are worked out",
                value:
                    "**Invested** — ETH and WETH you spent buying or minting\n" +
                    "**Sold** — proceeds from anything you've sold\n" +
                    "**Position** — what you still hold, at the current floor price\n" +
                    "**PNL** — sold plus position, minus invested"
            },
            {
                name: "Worth knowing",
                value:
                    "Gas isn't counted. Sale proceeds are before marketplace fees and royalties in " +
                    "some cases, so they can read slightly high. Position uses floor price, which is " +
                    "an estimate rather than what a specific token would fetch. " +
                    "Percentage shows as `—` when you paid nothing, since there's nothing to divide by."
            }
        );
}

client.on("interactionCreate", async (interaction) => {

    // ---- Unlink buttons from /wallets list ----
    if (interaction.isButton() && interaction.customId.startsWith("unlink_")) {
        const addr = interaction.customId.replace("unlink_", "").toLowerCase();
        const list = getWallets(interaction.user.id);
        const next = list.filter(w => w.toLowerCase() !== addr);

        if (next.length === list.length) {
            return interaction.reply({ content: "That wallet isn't linked.", ephemeral: true });
        }

        walletDB[interaction.user.id] = next;
        saveWallets();

        return interaction.reply({
            content: `Unlinked \`${addr}\`. ${next.length} wallet(s) still linked.`,
            ephemeral: true
        });
    }

    if (!interaction.isChatInputCommand()) return;

    // ---- /help ----
    if (interaction.commandName === "help") {
        return interaction.reply({ embeds: [buildHelpEmbed()], ephemeral: true });
    }

    // ---- /wallets ----
    if (interaction.commandName === "wallets") {
        const sub = interaction.options.getSubcommand();
        const userId = interaction.user.id;
        const list = getWallets(userId);

        if (sub === "add") {
            const address = interaction.options.getString("address").trim();

            if (!ethers.isAddress(address)) {
                return interaction.reply({
                    content: "That doesn't look like a wallet address. It should start with `0x` and be 42 characters long.",
                    ephemeral: true
                });
            }

            if (list.some(w => w.toLowerCase() === address.toLowerCase())) {
                return interaction.reply({ content: "That wallet is already linked.", ephemeral: true });
            }

            if (list.length >= 10) {
                return interaction.reply({
                    content: "You've hit the 10 wallet limit. Remove one with `/wallets remove` first.",
                    ephemeral: true
                });
            }

            walletDB[userId] = [...list, address];
            saveWallets();

            return interaction.reply({
                content: `Linked \`${address}\`. You now have ${walletDB[userId].length} wallet(s) linked.`,
                ephemeral: true
            });
        }

        if (sub === "remove") {
            const address = interaction.options.getString("address").trim().toLowerCase();
            const next = list.filter(w => w.toLowerCase() !== address);

            if (next.length === list.length) {
                return interaction.reply({
                    content: "That wallet isn't linked. Run `/wallets list` to see what is.",
                    ephemeral: true
                });
            }

            walletDB[userId] = next;
            saveWallets();

            return interaction.reply({
                content: `Unlinked \`${address}\`. ${next.length} wallet(s) still linked.`,
                ephemeral: true
            });
        }

        if (sub === "list") {
            if (!list.length) {
                return interaction.reply({
                    content: "No wallets linked yet. Add one with `/wallets add`.",
                    ephemeral: true
                });
            }

            const embed = new EmbedBuilder()
                .setTitle("Your linked wallets")
                .setColor("#00f2f2")
                .setDescription(list.map((w, i) => `**${i + 1}.** \`${w}\``).join("\n"))
                .setFooter({ text: "/profit adds all of these together" });

            // A button per wallet, three to a row
            const rows = [];
            for (let i = 0; i < list.length; i += 3) {
                const row = new ActionRowBuilder().addComponents(
                    list.slice(i, i + 3).map(w =>
                        new ButtonBuilder()
                            .setCustomId(`unlink_${w.toLowerCase()}`)
                            .setLabel(`Unlink ${w.slice(0, 6)}…${w.slice(-4)}`)
                            .setStyle(ButtonStyle.Secondary)
                    )
                );
                rows.push(row);
            }

            return interaction.reply({
                embeds: [embed],
                components: rows.slice(0, 5),
                ephemeral: true
            });
        }
    }

    // ---- /debug ----
    if (interaction.commandName === "debug") {
        const contract = interaction.options.getString("contract").trim();
        const chain = interaction.options.getString("chain") || "eth";
        const wallets = getWallets(interaction.user.id);

        if (!wallets.length) {
            return interaction.reply({ content: "Link a wallet first with `/wallets add`.", ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const lines = [];
        lines.push(`chain: ${chain}   contract: ${contract}`);
        lines.push(`ETH price: $${await getEthPrice()}`);

        for (const w of wallets) {
            const wallet = w.toLowerCase();
            lines.push("");
            lines.push(`WALLET ${wallet}`);

            try {
                const [nftIn, nftOut] = await Promise.all([
                    getAllTransfers(chain, {
                        toAddress: wallet, contractAddresses: [contract],
                        category: ["erc721", "erc1155"], withMetadata: false
                    }),
                    getAllTransfers(chain, {
                        fromAddress: wallet, contractAddresses: [contract],
                        category: ["erc721", "erc1155"], withMetadata: false
                    })
                ]);

                lines.push(`  NFTs in: ${nftIn.length}   NFTs out: ${nftOut.length}`);

                for (const t of nftIn) {
                    lines.push(`   IN  ${t.hash?.slice(0, 12)} block=${t.blockNum} token=${t.tokenId ?? "?"}`);
                }
                for (const t of nftOut) {
                    lines.push(`   OUT ${t.hash?.slice(0, 12)} block=${t.blockNum} token=${t.tokenId ?? "?"}`);
                }

                // What value moved in each relevant block
                const blocks = [...new Set([...nftIn, ...nftOut].map(t => t.blockNum).filter(Boolean))];
                for (const b of blocks) {
                    for (const dir of ["in", "out"]) {
                        const map = await valueMovedInBlock(chain, wallet, b, dir);
                        const entries = Object.entries(map);
                        if (!entries.length) {
                            lines.push(`   block ${b} ${dir}: nothing`);
                        } else {
                            for (const [h, v] of entries) {
                                lines.push(`   block ${b} ${dir}: ${h.slice(0, 12)} = ${v}Ξ`);
                            }
                        }
                    }
                }
            } catch (e) {
                lines.push(`  ERROR: ${e.message}`);
            }
        }

        const floor = await getFloorPrice(contract, chain);
        lines.push("");
        lines.push(`floor: ${floor === null ? "unknown" : floor + "Ξ"}`);

        let out = lines.join("\n");
        if (out.length > 1900) out = out.slice(0, 1900) + "\n... truncated";

        return interaction.editReply({ content: "```\n" + out + "\n```" });
    }

    // ---- /profit ----
    if (interaction.commandName === "profit") {
        const contract = interaction.options.getString("contract").trim();
        const chain = interaction.options.getString("chain") || "eth";
        const wallets = getWallets(interaction.user.id);

        if (!wallets.length) {
            return interaction.reply({
                content: "No wallet linked yet. Run `/wallets add` first, or `/help` for a walkthrough.",
                ephemeral: true
            });
        }

        if (!ethers.isAddress(contract)) {
            return interaction.reply({
                content: "That contract address doesn't look right. It should start with `0x` and be 42 characters long.",
                ephemeral: true
            });
        }

        await interaction.deferReply();

        try {
            const [pnlData, collectionInfo] = await Promise.all([
                calculatePnL(wallets, contract, chain),
                getCollectionInfo(contract, chain)
            ]);

            if (pnlData.buyCount === 0 && pnlData.sellCount === 0) {
                return interaction.editReply(
                    `No activity found for this collection on **${chain === "rbh" ? "Robinhood Chain" : "Ethereum"}** ` +
                    `across your ${wallets.length} linked wallet(s). If you traded it on the other chain, ` +
                    `pick that from the chain dropdown.`
                );
            }

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
            await interaction.editReply("Couldn't work that one out. Check the contract address and chain, then try again.");
        }
    }
});

client.login(BOT_TOKEN);
