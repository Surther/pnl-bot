const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, AttachmentBuilder } = require("discord.js");
const { createCanvas, loadImage } = require("canvas");
const axios = require("axios");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// ============ CONFIG ============
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const ETH_RPC = "https://eth-mainnet.g.alchemy.com/v2/alch_plU6kpqJ7kP8onBcnnTOf";
const RBH_RPC = "https://robinhood-mainnet.g.alchemy.com/v2/alch_ZxPo1wF48uFzadUXFMUt9";
const ALCHEMY_ETH_KEY = "alch_plU6kpqJ7kP8onBcnnTOf";
const ALCHEMY_RBH_KEY = "alch_ZxPo1wF48uFzadUXFMUt9";

const ethProvider = new ethers.JsonRpcProvider(ETH_RPC);
const rbhProvider = new ethers.JsonRpcProvider(RBH_RPC);

// Wallet storage (in memory — persists while bot is running)
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

// ============ REGISTER COMMANDS ============
async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("Slash commands registered!");
}

// ============ FETCH NFT DATA ============
async function getNFTData(walletAddress, contractAddress, chain) {
    const isEth = chain !== "rbh";
    const apiKey = isEth ? ALCHEMY_ETH_KEY : ALCHEMY_RBH_KEY;
    const baseUrl = isEth
        ? `https://eth-mainnet.g.alchemy.com/nft/v3/${apiKey}`
        : `https://robinhood-mainnet.g.alchemy.com/nft/v3/${apiKey}`;

    try {
        // Get NFT transfers for this wallet + contract
        const transfersRes = await axios.get(`${baseUrl}/getTransfersForOwner`, {
            params: {
                owner: walletAddress,
                contractAddresses: [contractAddress],
                withMetadata: true,
            }
        });

        // Get collection metadata
        const metaRes = await axios.get(`${baseUrl}/getContractMetadata`, {
            params: { contractAddress }
        });

        return {
            transfers: transfersRes.data,
            metadata: metaRes.data
        };
    } catch (e) {
        console.error("NFT fetch error:", e.message);
        return null;
    }
}

// ============ FETCH WALLET TRANSACTIONS ============
async function getWalletTransactions(walletAddress, contractAddress, chain) {
    const isEth = chain !== "rbh";
    const apiKey = isEth ? ALCHEMY_ETH_KEY : ALCHEMY_RBH_KEY;
    const baseUrl = isEth
        ? `https://eth-mainnet.g.alchemy.com/v2/${apiKey}`
        : `https://robinhood-mainnet.g.alchemy.com/v2/${apiKey}`;

    try {
        // Get asset transfers
        const res = await axios.post(baseUrl, {
            jsonrpc: "2.0",
            id: 1,
            method: "alchemy_getAssetTransfers",
            params: [{
                fromAddress: walletAddress,
                contractAddresses: [contractAddress],
                category: ["erc721", "erc1155"],
                withMetadata: true,
                maxCount: "0x64"
            }]
        });

        const res2 = await axios.post(baseUrl, {
            jsonrpc: "2.0",
            id: 2,
            method: "alchemy_getAssetTransfers",
            params: [{
                toAddress: walletAddress,
                contractAddresses: [contractAddress],
                category: ["erc721", "erc1155"],
                withMetadata: true,
                maxCount: "0x64"
            }]
        });

        return {
            sent: res.data.result?.transfers || [],
            received: res2.data.result?.transfers || []
        };
    } catch (e) {
        console.error("Transfer fetch error:", e.message);
        return { sent: [], received: [] };
    }
}

// ============ FETCH ETH PRICE ============
async function getEthPrice() {
    try {
        const res = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
        return res.data.ethereum.usd;
    } catch {
        return 2500; // fallback
    }
}

// ============ CALCULATE PNL ============
async function calculatePnL(walletAddress, contractAddress, chain) {
    const { sent, received } = await getWalletTransactions(walletAddress, contractAddress, chain);
    const ethPrice = await getEthPrice();

    // Buys = received NFTs (someone sent to us)
    // Sells = sent NFTs (we sent to someone)
    let totalSpentEth = 0;
    let totalReceivedEth = 0;
    let buyCount = 0;
    let sellCount = 0;

    // Process received (buys) — look at the tx value
    const isEth = chain !== "rbh";
    const provider = isEth ? ethProvider : rbhProvider;

    for (const tx of received) {
        try {
            if (tx.hash) {
                const txData = await provider.getTransaction(tx.hash);
                if (txData && txData.value) {
                    const ethVal = parseFloat(ethers.formatEther(txData.value));
                    totalSpentEth += ethVal;
                    buyCount++;
                }
            }
        } catch (e) {}
    }

    for (const tx of sent) {
        try {
            if (tx.hash) {
                const txData = await provider.getTransaction(tx.hash);
                if (txData && txData.value) {
                    const ethVal = parseFloat(ethers.formatEther(txData.value));
                    totalReceivedEth += ethVal;
                    sellCount++;
                }
            }
        } catch (e) {}
    }

    const pnlEth = totalReceivedEth - totalSpentEth;
    const pnlUsd = pnlEth * ethPrice;
    const investedUsd = totalSpentEth * ethPrice;
    const positionUsd = totalReceivedEth * ethPrice;
    const pnlPercent = totalSpentEth > 0 ? (pnlEth / totalSpentEth) * 100 : 0;
    const heldCount = Math.max(0, buyCount - sellCount);

    return {
        pnlEth,
        pnlUsd,
        investedUsd,
        positionUsd,
        pnlPercent,
        buyCount,
        sellCount,
        heldCount,
        ethPrice,
        isProfit: pnlUsd >= 0
    };
}

// ============ FETCH COLLECTION INFO ============
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

// ============ GENERATE PNL IMAGE ============
async function generatePnLImage(data, collectionName, collectionImage, username) {
    const W = 1320, H = 740;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");

    // Load background
    try {
        const bg = await loadImage(path.join(__dirname, "assets", "background.png"));
        ctx.drawImage(bg, 0, 0, W, H);
    } catch {
        // Fallback gradient background
        const grad = ctx.createLinearGradient(0, 0, W, H);
        grad.addColorStop(0, "#050a1a");
        grad.addColorStop(1, "#0a1628");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
    }

    // Dark overlay on left side for text readability
    const overlay = ctx.createLinearGradient(0, 0, W * 0.7, 0);
    overlay.addColorStop(0, "rgba(0,0,0,0.75)");
    overlay.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = overlay;
    ctx.fillRect(0, 0, W, H);

    // ---- ORIGINS LOGO + NAME (top left) ----
    try {
        const logo = await loadImage(path.join(__dirname, "assets", "logo.png"));
        ctx.drawImage(logo, 48, 40, 52, 52);
    } catch {}

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 28px Arial";
    ctx.fillText("origins", 112, 76);

    // ---- COLLECTION NAME (big) ----
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 72px Arial";
    const collName = collectionName.toUpperCase();
    ctx.fillText(collName, 50, 220);

    // ---- PNL BOX ----
    const boxColor = data.isProfit ? "#00e88a" : "#ff4444";
    const pnlText = data.isProfit
        ? `+$${formatNum(Math.abs(data.pnlUsd))}`
        : `-$${formatNum(Math.abs(data.pnlUsd))}`;

    const boxW = Math.min(680, ctx.measureText(pnlText).width + 60);
    const boxH = 100;
    const boxX = 50;
    const boxY = 250;

    ctx.fillStyle = boxColor;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 8);
    ctx.fill();

    ctx.fillStyle = "#000000";
    ctx.font = "bold 68px Arial";
    ctx.fillText(pnlText, boxX + 24, boxY + 74);

    // ---- STATS ----
    const statsY = 420;
    const statsGap = 56;

    ctx.font = "32px Arial";

    // PNL %
    ctx.fillStyle = "#aaaaaa";
    ctx.fillText("PNL", 50, statsY);
    ctx.fillStyle = data.isProfit ? "#00e88a" : "#ff4444";
    const pnlPct = `${data.isProfit ? "+" : ""}${data.pnlPercent.toFixed(2)}%`;
    ctx.fillText(pnlPct, 280, statsY);

    // Invested
    ctx.fillStyle = "#aaaaaa";
    ctx.fillText("Invested", 50, statsY + statsGap);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`$${formatNum(data.investedUsd)}`, 280, statsY + statsGap);

    // Position
    ctx.fillStyle = "#aaaaaa";
    ctx.fillText("Position", 50, statsY + statsGap * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`$${formatNum(data.positionUsd)}`, 280, statsY + statsGap * 2);

    // ---- COLLECTION IMAGE (small, top left area) ----
    if (collectionImage) {
        try {
            const img = await loadImage(collectionImage);
            ctx.save();
            ctx.beginPath();
            ctx.arc(160, 145, 45, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(img, 115, 100, 90, 90);
            ctx.restore();
        } catch {}
    }

    // ---- WATERMARK ----
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "22px Arial";
    ctx.fillText(`by @${username}`, W - 220, H - 30);

    return canvas.toBuffer("image/png");
}

function formatNum(num) {
    if (Math.abs(num) >= 1000) return (num / 1000).toFixed(2) + "K";
    return num.toFixed(1);
}

// ============ BOT CLIENT ============
const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

client.once("ready", async () => {
    console.log(`PNL Bot logged in as ${client.user.tag}`);
    await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // /wallet command
    if (interaction.commandName === "wallet") {
        const address = interaction.options.getString("address");

        if (!ethers.isAddress(address)) {
            return interaction.reply({ content: "❌ Invalid wallet address!", ephemeral: true });
        }

        walletDB[interaction.user.id] = address;
        return interaction.reply({
            content: `✅ Wallet linked: \`${address}\``,
            ephemeral: true
        });
    }

    // /profit command
    if (interaction.commandName === "profit") {
        const contract = interaction.options.getString("contract");
        const chain = interaction.options.getString("chain") || "eth";
        const wallet = walletDB[interaction.user.id];

        if (!wallet) {
            return interaction.reply({
                content: "❌ No wallet linked! Use `/wallet` first.",
                ephemeral: true
            });
        }

        if (!ethers.isAddress(contract)) {
            return interaction.reply({
                content: "❌ Invalid contract address!",
                ephemeral: true
            });
        }

        await interaction.deferReply();

        try {
            // Fetch data
            const [pnlData, collectionInfo] = await Promise.all([
                calculatePnL(wallet, contract, chain),
                getCollectionInfo(contract, chain)
            ]);

            // Generate image
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
