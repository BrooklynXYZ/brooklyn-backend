import "dotenv/config";
import { setApiKey, createCoin, DeployCurrency } from "@zoralabs/coins-sdk";
import { Hex, createWalletClient, createPublicClient, http, Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { PinataSDK } from "pinata";
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

const pinata = new PinataSDK({
  pinataJwt: process.env.PINATA_JWT,
  pinataGateway: process.env.GATEWAY_URL
});

async function uploadImageToIPFS(filePath: string) {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    
    // Create a File-like object that's compatible with Pinata
    const file = new File([fileBuffer], fileName, { 
      type: "image/png" // Use appropriate MIME type for your image
    });
    
    const upload = await pinata.upload.public.file(file);
    console.log('✅ Image uploaded to IPFS:');
    console.log('CID:', upload.cid);
    console.log('Gateway:', `https://gateway.pinata.cloud/ipfs/${upload.cid}`);
    return upload.cid;
  } catch (error) {
    console.error('❌ Upload failed:', error);
    throw error;
  }
}

async function getNextPendingNFT() {
  const { data, error } = await supabase
    .from('nft_queue')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      // No rows returned
      console.log('📭 No pending NFTs in queue', error);
      return null;
    }
    throw error;
  }

  return data;
}

async function updateNFTStatus(id: number, status: string, updates: any = {}) {
  const { error } = await supabase
    .from('nft_queue')
    .update({ status, ...updates })
    .eq('id', id);

  if (error) throw error;
}

async function main() {
  try {
    // Get the next pending NFT from database
    const nftData = await getNextPendingNFT();
    
    if (!nftData) {
      console.log('No pending NFTs to process');
      return;
    }

    console.log(`Processing: ${nftData.name}`);
    
    // Mark as processing
    await updateNFTStatus(nftData.id, 'processing');

    // Upload image first and wait for it to complete
    // const imagePath = path.resolve(nftData.image_path);
    // const ipfsHash = await uploadImageToIPFS(imagePath);
    const ipfsHash = nftData.nft_ipfshash;
    // Create metadata object with the IPFS hash
    const metadata = {
      name: nftData.name,
      description: nftData.description,
      image: `ipfs://${ipfsHash}`,
      properties: {
        category: "social"
      }
    };
    
    // Upload metadata to IPFS
    const metadataUpload = await pinata.upload.public.json(metadata);
    const metadataCid = metadataUpload.cid;
    
    console.log('✅ Metadata uploaded to IPFS:');
    console.log('Metadata CID:', metadataCid);
    
    // Set up Zora SDK
    setApiKey(process.env.ZORA_KEY!);
    
    const privateKey = `0x${process.env.PRIVATE_KEY!}`;
    const account = privateKeyToAccount(privateKey as Address);
    
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http("https://base-sepolia.g.alchemy.com/v2/oKxs-03sij-U_N0iOlrSsZFr29-IqbuF"),
    });
    
    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http("https://base-sepolia.g.alchemy.com/v2/oKxs-03sij-U_N0iOlrSsZFr29-IqbuF"),
    });
    
    const coinParams = {
      name: nftData.name,
      symbol: 'BRKLYN',
      uri: `ipfs://${metadataCid}`, // Use proper IPFS URI format
      payoutRecipient: walletClient.account.address as Address,
      chainId: baseSepolia.id,
      currency: DeployCurrency.ETH,
    };
    
    // Create the coin
    const result = await createCoin(coinParams, walletClient, publicClient, {
      gasMultiplier: 120,
    });
    
    console.log("✅ Transaction hash:", result.hash);
    console.log("✅ Coin address:", result.address);
    console.log("📦 Deployment details:", result.deployment);

    // Mark as completed and save transaction details
    await updateNFTStatus(nftData.id, 'completed', {
      tx: result.hash,
      coin: result.address,
      posted_at: new Date().toISOString()
    });

    return result;
  } catch (error) {
    console.error("❌ Error:", error);
    
    // If we have an NFT being processed, mark it as failed
    try {
      const nftData = await getNextPendingNFT();
      if (nftData) {
        await updateNFTStatus(nftData.id, 'failed', {
          error_message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    } catch (dbError) {
      console.error("❌ Database error:", dbError);
    }
    
    throw error;
  }
}

// Run the main function
main();