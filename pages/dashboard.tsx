/**
 * Copyright (c) 2024 Blockchain at Berkeley.  All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * SPDX-License-Identifier: MIT
 */
import { useRouter } from "next/router";
import React, { useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import Head from "next/head";
import {
  chainToUrl,
  abbreviateTransactionHash,
  BACKEND_URL,
  sendTransaction,
  sendOrder,
  waitForOrderStatus,
  uniswapV2Swap,
  processBuyRequest,
} from "../util/utils";
import { ethers } from "ethers";
import { OrderStatus } from "@cowprotocol/cow-sdk";
import { encode_abi } from "eth-abi";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

interface TransactionHistoryItem {
  id: string;
  timestamp: number;
  type: "transfer" | "swap" | "buy" | "remittance";
  status: "pending" | "completed" | "failed";
  data: {
    transactionHash?: string;
    chain?: string;
    fromAsset?: string;
    toAsset?: string;
    amount?: string;
    recipientAddress?: string;
    orderId?: string;
    moonpayUrl?: string;
    exchangeRates?: any;
    fees?: any;
  };
  message: string;
}

interface TokenBalance {
  address: string;
  symbol: string;
  balance: string;
  decimals: number;
}

export default function DashboardPage() {
  const [intentValue, setIntentValue] = useState<string>("");
  const [status, setStatus] = useState<React.ReactNode>(<></>);
  const [showStatusPopup, setShowStatusPopup] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [userName, setUserName] = useState<string>("");
  const [transactionHistory, setTransactionHistory] = useState<TransactionHistoryItem[]>([]);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [remittanceCost, setRemittanceCost] = useState<any>(null);
  const [showCostSimulation, setShowCostSimulation] = useState<boolean>(false);
  const [tokenBalances, setTokenBalances] = useState<Record<string, TokenBalance>>({});
  const [currentRemittanceStep, setCurrentRemittanceStep] = useState<number>(1);
  const [remittanceFlowData, setRemittanceFlowData] = useState<any>(null);
  
  const router = useRouter();
  const { ready, authenticated, logout } = usePrivy();

  useEffect(() => { 
    if (ready && !authenticated) {
      void router.push("/");
    }
    
    if (typeof window !== 'undefined') {
      const storedName = localStorage.getItem("brinco_user_name");
      setUserName(storedName || "");
      
      // Load transaction history from localStorage
      const storedHistory = localStorage.getItem("brinco_transaction_history");
      if (storedHistory) {
        try {
          setTransactionHistory(JSON.parse(storedHistory));
        } catch (e) {
          console.error("Failed to parse transaction history:", e);
        }
      }
    }
  }, [ready, authenticated, router]);

  // Save transaction history to localStorage whenever it changes
  useEffect(() => {
    if (transactionHistory.length > 0) {
      localStorage.setItem("brinco_transaction_history", JSON.stringify(transactionHistory));
    }
  }, [transactionHistory]);

  useEffect(() => {
    if (remittanceFlowData) {
      localStorage.setItem("brinco_remittance_flow", JSON.stringify({
        data: remittanceFlowData,
        step: currentRemittanceStep
      }));
    }
  }, [remittanceFlowData, currentRemittanceStep]);

  useEffect(() => {
    if (ready && authenticated) {
      const storedFlowData = localStorage.getItem("brinco_remittance_flow");
      if (storedFlowData) {
        try {
          const parsedData = JSON.parse(storedFlowData);
          setRemittanceFlowData(parsedData.data);
          setCurrentRemittanceStep(parsedData.step);
        } catch (e) {
          console.error("Failed to parse stored remittance flow data:", e);
        }
      }
    }
  }, [ready, authenticated]);

  const { wallets } = useWallets();
  
  const addTransactionToHistory = (item: Omit<TransactionHistoryItem, 'id' | 'timestamp'>) => {
    const newItem: TransactionHistoryItem = {
      ...item,
      id: `tx-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      timestamp: Date.now(),
    };
    
    setTransactionHistory(prev => [newItem, ...prev].slice(0, 10)); // Keep 10 transactions
  };
  
  const updateTransactionInHistory = (id: string, updates: Partial<TransactionHistoryItem>) => {
    setTransactionHistory(prev => 
      prev.map(item => 
        item.id === id ? { ...item, ...updates } : item
      )
    );
  };
  
  const checkNetwork = async (chain: string) => {
    if (!wallets[0]) {
      throw new Error("No wallet connected");
    }

    try {
      const provider = await wallets[0].getEthersProvider();
      const network = await provider.getNetwork();
      
      const chainIds: { [key: string]: number } = {
        'mainnet': 1,
        'sepolia': 11155111,
        'base': 8453
      };

      const targetChainId = chainIds[chain];
      if (!targetChainId) {
        throw new Error(`Unsupported chain: ${chain}`);
      }

      if (network.chainId !== targetChainId) {
        try {
          await wallets[0].switchChain(targetChainId);
          const newProvider = await wallets[0].getEthersProvider();
          await newProvider.getNetwork(); 
          setNetworkError(null);
        } catch (switchError) {
          console.error("Failed to switch network:", switchError);
          throw new Error(`Please switch your wallet to ${chain} network`);
        }
      }

      await provider.getBlockNumber();
      setNetworkError(null);
    } catch (error) {
      console.error("Network check failed:", error);
      if (error instanceof Error) {
        if (error.message.includes("could not detect network")) {
          throw new Error(`Unable to connect to ${chain} network. Please check your internet connection and wallet network settings.`);
        }
        throw error;
      }
      throw new Error("Network connection failed. Please check your internet connection.");
    }
  };

  const checkTokenBalance = async (tokenAddress: string, walletAddress: string) => {
    try {
      if (!wallets[0]) {
        throw new Error("No wallet connected");
      }
      
      const provider = await wallets[0].getEthersProvider();
      const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      
      const balance = await tokenContract.balanceOf(walletAddress);
      const decimals = await tokenContract.decimals();
      const symbol = await tokenContract.symbol();
      
      const formattedBalance = ethers.utils.formatUnits(balance, decimals);
      
      // Update the token balances state
      setTokenBalances(prev => ({
        ...prev,
        [tokenAddress]: {
          address: tokenAddress,
          symbol: symbol,
          balance: formattedBalance,
          decimals: decimals
        }
      }));
      
      return formattedBalance;
    } catch (error) {
      console.error("Failed to check token balance:", error);
      return "0";
    }
  };

  // Function to execute a transaction step
  const executeRemittanceStep = async (stepData: any) => {
    try {
      if (!wallets[0]) {
        throw new Error("No wallet connected");
      }
      
      // Get the current wallet address - this is key to fixing the error
      const walletAddress = wallets[0].address;
      console.log("🔍 Starting executeRemittanceStep with wallet address:", walletAddress);
      
      if (stepData.check_balance) {
        console.log("📊 Executing balance check for token:", stepData.check_balance.token_address);
        const balance = await checkTokenBalance(
          stepData.check_balance.token_address,
          walletAddress 
        );
        
        return {
          success: true,
          type: "balance_check",
          balance
        };
      }
      
      if (!stepData.requires_signature) {
        // No signature required, just return success
        console.log("✅ Step doesn't require signature, returning success");
        return {
          success: true,
          type: "no_signature_required"
        };
      }
      
      // Execute the transaction
      const provider = await wallets[0].getEthersProvider();
      console.log("🔗 Connected to blockchain provider, network:", await provider.getNetwork());
      const signer = provider.getSigner();
      
      // Create a new transaction object with the correct from address
      const txData = { 
        ...stepData.tx_data,
        from: walletAddress 
      };
      
      if (txData.gas) {
        txData.gasLimit = txData.gas;
        delete txData.gas;
      }
      
      console.log("📝 Preparing to send transaction with data:", JSON.stringify(txData, null, 2));
      
      // Send the transaction with the corrected data
      console.log("🚀 Sending transaction...");
      const tx = await signer.sendTransaction(txData);
      console.log("📨 Transaction sent! Hash:", tx.hash);
      console.log("📊 Transaction details:", JSON.stringify(tx, null, 2));
      
      // Set loading state to show transaction is being processed
      setLoading(true);
      setStatus(
        <div className="text-center">
          <h3 className="text-xl font-semibold mb-4">Transaction Submitted</h3>
          <div className="bg-secondary/20 p-4 rounded-lg mb-4">
            <p className="mb-2">Your transaction has been submitted and is being processed.</p>
            <p className="text-sm text-gray-400">Transaction hash: {tx.hash}</p>
            <div className="mt-4 flex justify-center">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
            </div>
          </div>
          <p className="text-sm text-gray-400">Please wait, this may take up to a minute...</p>
        </div>
      );
      
      // Wait for one confirmation with a timeout to prevent hanging
      console.log("⏱️ Waiting for transaction confirmation...");
      
      // Create a promise that rejects after timeout
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Transaction confirmation timeout after 60 seconds")), 60000)
      );
      
      // Race between the transaction confirmation and the timeout
      try {
        const receipt = await Promise.race([
          tx.wait(1),
          timeout
        ]) as ethers.providers.TransactionReceipt;
        
        console.log("✅ Transaction confirmed! Receipt:", JSON.stringify(receipt, null, 2));
        return {
          success: true,
          type: "transaction",
          hash: receipt.transactionHash
        };
      } catch (timeoutError) {
        console.error("⏱️ Transaction wait timed out or failed:", timeoutError);
        
        // Even if waiting times out, the transaction might still complete successfully later
        console.log("🔍 Checking transaction status directly...");
        try {
          const latestStatus = await provider.getTransaction(tx.hash);
          console.log("📊 Latest transaction status:", JSON.stringify(latestStatus, null, 2));
          
          if (latestStatus && latestStatus.blockNumber) {
            console.log("✅ Transaction was mined in block:", latestStatus.blockNumber);
            return {
              success: true,
              type: "transaction",
              hash: tx.hash,
              note: "Confirmed via direct check after timeout"
            };
          } else {
            console.log("⏳ Transaction still pending after timeout");
            return {
              success: true,
              type: "transaction",
              hash: tx.hash,
              pending: true,
              note: "Transaction submitted but confirmation timed out. It may still complete later."
            };
          }
        } catch (statusCheckError) {
          console.error("❌ Failed to check transaction status:", statusCheckError);
          throw new Error(`Transaction submitted (${tx.hash}) but confirmation status unknown: ${timeoutError}`);
        }
      }
    } catch (error) {
      console.error("❌ Failed to execute remittance step:", error);
      
      // Check if it's a user rejection
      let errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ Error details:", errorMessage);
      
      if (errorMessage.includes("user rejected") || errorMessage.includes("User denied")) {
        console.log("🚫 Transaction was rejected by user");
        return {
          success: false,
          error: "Transaction was rejected in your wallet. Please try again.",
          userRejected: true
        };
      }
      
      return {
        success: false,
        error: errorMessage
      };
    }
  };

  // Add a utility function to check transaction status
  const checkTransactionStatus = async (txHash: string, chain: string) => {
    try {
      if (!wallets[0]) {
        throw new Error("No wallet connected");
      }
      
      console.log("🔍 Manually checking transaction status for hash:", txHash);
      
      // Ensure we're on the right network
      await checkNetwork(chain);
      
      const provider = await wallets[0].getEthersProvider();
      
      // First check if the transaction is in the mempool
      const tx = await provider.getTransaction(txHash);
      console.log("📊 Transaction details:", tx ? JSON.stringify(tx, null, 2) : "Not found");
      
      if (!tx) {
        return { found: false, status: "not_found" };
      }
      
      // If the transaction has a blockNumber, it has been mined
      if (tx.blockNumber) {
        // Now get the receipt to check status
        const receipt = await provider.getTransactionReceipt(txHash);
        console.log("📝 Transaction receipt:", receipt ? JSON.stringify(receipt, null, 2) : "Receipt not found");
        
        if (receipt) {
          // status: 1 = success, 0 = failure
          return { 
            found: true, 
            mined: true, 
            successful: receipt.status === 1,
            blockNumber: receipt.blockNumber,
            receipt: receipt
          };
        }
        
        // Transaction mined but no receipt yet
        return { found: true, mined: true, blockNumber: tx.blockNumber };
      }
      
      // Transaction found but not yet mined
      return { found: true, mined: false, status: "pending" };
      
    } catch (error) {
      console.error("❌ Error checking transaction status:", error);
      return { found: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  };

  // Add a helper function to process the next step explicitly
  const processNextStep = (flowData: any, nextStepNumber: number) => {
    console.log(`🔼 Explicitly processing next step: ${nextStepNumber} (current state value: ${currentRemittanceStep})`);
    // Update the step in state
    setCurrentRemittanceStep(nextStepNumber);
    console.log(`🔄 State update requested: currentRemittanceStep → ${nextStepNumber}`);
    
    // Update in localStorage to ensure persistence
    localStorage.setItem("brinco_remittance_flow", JSON.stringify({
      data: flowData,
      step: nextStepNumber
    }));
    console.log(`💾 localStorage updated with step ${nextStepNumber}`);
    
    // Process with the updated step - pass the nextStepNumber directly
    console.log(`⏱️ Setting timeout to process step ${nextStepNumber} in 100ms`);
    setTimeout(() => {
      console.log(`⏰ Timeout fired! Processing step ${nextStepNumber} now`);
      processRemittanceFlow(flowData, nextStepNumber);
    }, 100);
  };

  // Function to handle the remittance process
  const processRemittanceFlow = async (flowData: any, forceStep?: number) => {
    if (!flowData || !flowData.transaction_flow) {
      console.log("❌ No flow data available to process");
      return;
    }
    
    const totalSteps = Object.keys(flowData.transaction_flow).length;
    

    let currentStep = forceStep !== undefined ? forceStep : currentRemittanceStep;
    console.log(`🔄 Initial step from state: ${currentStep} of ${totalSteps}`);
    
    // If current step is invalid (less than 1 or greater than total), reset to 1
    if (currentStep < 1 || currentStep > totalSteps) {
      console.log(`⚠️ Invalid step detected: ${currentStep}. Resetting to step 1`);
      currentStep = 1;
      setCurrentRemittanceStep(1);
      // Update localStorage to ensure consistency
      localStorage.setItem("brinco_remittance_flow", JSON.stringify({
        data: flowData,
        step: 1
      }));
    }
    
    console.log(`🔄 Processing remittance flow: Step ${currentStep} of ${totalSteps}`);
    console.log(`🔍 Current step being processed: ${currentStep}`);
    
    // Check initial token balances if using test tokens
    if (flowData.using_test_tokens && flowData.token_addresses && wallets[0]?.address) {
      console.log("📊 Checking initial token balances");
      await checkTokenBalance(flowData.token_addresses.tUSD, wallets[0].address);
      await checkTokenBalance(flowData.token_addresses.tEUR, wallets[0].address);
    }
    
    // Start processing the steps
    if (currentStep <= totalSteps) {
      const stepKey = `step${currentStep}`;
      const stepData = flowData.transaction_flow[stepKey];
      
      if (!stepData) {
        console.log(`❌ No data found for step ${currentStep}`);
        return;
      }
      
      console.log(`🔍 Processing step ${currentStep}: ${stepData.name}`);
      console.log(`📝 Step data:`, JSON.stringify(stepData, null, 2));
      
      // Update UI to indicate current step
      setStatus(
        <div className="text-center">
          <h3 className="text-xl font-semibold mb-4">Remittance Process</h3>
          <div className="bg-secondary/20 p-4 rounded-lg mb-4">
            <p className="mb-2">
              Step {currentStep} of {totalSteps}: {stepData.name}
            </p>
            <p className="text-sm text-gray-400 mb-2">{stepData.description}</p>
            {stepData.explain && (
              <p className="text-xs text-gray-500 mb-4">{stepData.explain}</p>
            )}
            <div className="w-full bg-gray-700 h-2 rounded-full overflow-hidden">
              <div 
                className="bg-primary h-full"
                style={{ width: `${(currentStep / totalSteps) * 100}%` }}
              ></div>
            </div>
          </div>
          
          {/* Display token balances if available */}
          {Object.keys(tokenBalances).length > 0 && (
            <div className="mt-4 p-4 bg-gray-900 rounded-lg border border-gray-800">
              <h4 className="text-primary font-medium mb-2">Token Balances</h4>
              <div className="grid grid-cols-2 gap-2">
                {Object.values(tokenBalances).map((token) => (
                  <div key={token.address} className="flex justify-between items-center">
                    <span>{token.symbol}:</span>
                    <span className="font-mono">{parseFloat(token.balance).toFixed(4)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          <div className="mt-4">
            <button
              onClick={() => executeCurrentStep()}
              className="btn-primary"
              disabled={loading}
            >
              {loading ? "Processing..." : `Execute Step ${currentStep}`}
            </button>
            {/* Add a Cancel button to allow exiting the process */}
            <button
              onClick={() => {
                // Clear remittance data from localStorage when canceling
                localStorage.removeItem("brinco_remittance_flow");
                setRemittanceFlowData(null);
                setCurrentRemittanceStep(1);
                setShowStatusPopup(false);
              }}
              className="btn-secondary ml-2"
              disabled={loading}
            >
              Cancel Process
            </button>
          </div>
        </div>
      );
      
      // Wait for user to execute the step
      const executeCurrentStep = async () => {
        setLoading(true);
        console.log(`▶️ Executing step ${currentStep}: ${stepData.name}`);
        const result = await executeRemittanceStep(stepData);
        console.log(`📊 Step ${currentStep} execution result:`, JSON.stringify(result, null, 2));
        setLoading(false);
        
        if (result.success) {
          // If there's a pending transaction hash, double-check its status
          if (result.pending && result.hash) {
            console.log("⏳ Transaction appears to be pending, checking status...");
            
            setStatus(
              <div className="text-center">
                <h3 className="text-xl font-semibold mb-4">Checking Transaction Status</h3>
                <div className="bg-secondary/20 p-4 rounded-lg mb-4">
                  <p className="mb-2">Please wait while we check the status of your transaction...</p>
                  <div className="mt-4 flex justify-center">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
                  </div>
                </div>
              </div>
            );
            
            // Wait a bit for the transaction to propogate
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Check transaction status
            const txStatus = await checkTransactionStatus(result.hash, "sepolia");
            console.log("📊 Manual transaction status check result:", JSON.stringify(txStatus, null, 2));
            
            if (txStatus.mined && txStatus.successful) {
              // Transaction succeeded!
              console.log("✅ Transaction was successful despite the timeout!");
              
              // Update the transaction history
              const stepInfo = flowData.transaction_flow[`step${currentStep}`];
              const stepName = typeof stepInfo === 'object' && stepInfo !== null && 'name' in stepInfo 
                ? String(stepInfo.name) 
                : "Transaction";
                
              addTransactionToHistory({
                type: "remittance",
                status: "completed",
                data: {
                  transactionHash: result.hash,
                  chain: "sepolia",
                  amount: flowData.amount?.toString() || "0",
                  recipientAddress: flowData.recipient_address || "",
                },
                message: `Completed remittance step ${currentStep}: ${stepName}`
              });
              
              // Update balances if using test tokens
              if (flowData.using_test_tokens && flowData.token_addresses && wallets[0]?.address) {
                await checkTokenBalance(flowData.token_addresses.tUSD, wallets[0].address);
                await checkTokenBalance(flowData.token_addresses.tEUR, wallets[0].address);
              }
              
              setStatus(
                <div className="text-center">
                  <h3 className="text-xl font-semibold mb-4">Step Completed</h3>
                  <div className="bg-green-100 p-4 rounded-lg mb-4">
                    <p className="text-green-800">✅ Transaction successful!</p>
                    <a
                      className="text-primary hover:text-primary/80 underline block mt-2"
                      href={`${chainToUrl.sepolia}${result.hash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View on Explorer: {abbreviateTransactionHash(result.hash || '')}
                    </a>
                  </div>
                  <button
                    onClick={() => {
                      const nextStep = currentStep + 1;
                      processNextStep(flowData, nextStep);
                    }}
                    className="btn-primary"
                  >
                    Next Step
                  </button>
                </div>
              );
              
              return;
            } else if (txStatus.found && !txStatus.mined) {
              // Transaction is still in the mempool/pending
              console.log("⏳ Transaction is still pending in the mempool");
            } else {
              // Transaction might be dropped or failed
              console.log("⚠️ Transaction might be dropped or failed");
            }
          }
          
          // Handle pending transactions
          if (result.pending) {
            console.log("⏳ Transaction is pending. Providing user option to continue or wait.");
            setStatus(
              <div className="text-center">
                <h3 className="text-xl font-semibold mb-4">Transaction Pending</h3>
                <div className="bg-yellow-50 p-4 rounded-lg mb-4">
                  <p className="text-yellow-800">
                    ⚠️ Your transaction was submitted, but confirmation is taking longer than expected.
                  </p>
                  <p className="text-sm mt-2">Transaction hash: {result.hash}</p>
                  <a
                    className="text-primary hover:text-primary/80 underline block mt-2"
                    href={`${chainToUrl.sepolia}${result.hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on Explorer: {result.hash ? abbreviateTransactionHash(result.hash || '') : ''}
                  </a>
                </div>
                <div className="flex justify-center space-x-4">
                  <button
                    onClick={() => {
                      console.log("👉 User chose to continue to next step anyway");
                      const nextStep = currentStep + 1;
                      // Use the explicit function to process the next step
                      processNextStep(flowData, nextStep);
                    }}
                    className="btn-primary"
                  >
                    Next Step
                  </button>
                  <button
                    onClick={() => {
                      console.log("🔄 User chose to try this step again");
                      processRemittanceFlow(flowData, currentStep);
                    }}
                    className="btn-secondary"
                  >
                    Try Again
                  </button>
                </div>
              </div>
            );
            return;
          }
          
          // Update the UI based on result type
          if (result.type === "balance_check") {
            // Just update the status to show the next step
            setStatus(
              <div className="text-center">
                <h3 className="text-xl font-semibold mb-4">Balance Check Complete</h3>
                <div className="bg-green-100 p-4 rounded-lg mb-4">
                  <p className="text-green-800">
                    ✅ Balance check complete! You have {result.balance} tokens.
                  </p>
                </div>
                <button
                  onClick={() => {
                    const nextStep = currentStep + 1;
                    // Use the explicit function to process the next step
                    processNextStep(flowData, nextStep);
                  }}
                  className="btn-primary"
                >
                  Next Step
                </button>
              </div>
            );
          } else if (result.type === "transaction") {
            // Update the transaction history
            const stepInfo = flowData.transaction_flow[`step${currentStep}`];
            const stepName = typeof stepInfo === 'object' && stepInfo !== null && 'name' in stepInfo 
              ? String(stepInfo.name) 
              : "Transaction";
              
            addTransactionToHistory({
              type: "remittance",
              status: "completed",
              data: {
                transactionHash: result.hash,
                chain: "sepolia",
                amount: flowData.amount?.toString() || "0",
                recipientAddress: flowData.recipient_address || "",
              },
              message: `Completed remittance step ${currentStep}: ${stepName}`
            });
            
            // Update balances if using test tokens
            if (flowData.using_test_tokens && flowData.token_addresses && wallets[0]?.address) {
              await checkTokenBalance(flowData.token_addresses.tUSD, wallets[0].address);
              await checkTokenBalance(flowData.token_addresses.tEUR, wallets[0].address);
            }
            
            // Show success and proceed to next step with button
            setStatus(
              <div className="text-center">
                <h3 className="text-xl font-semibold mb-4">Step Completed</h3>
                <div className="bg-green-100 p-4 rounded-lg mb-4">
                  <p className="text-green-800">✅ Transaction successful!</p>
                  <a
                    className="text-primary hover:text-primary/80 underline block mt-2"
                    href={`${chainToUrl.sepolia}${result.hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on Explorer: {abbreviateTransactionHash(result.hash || '')}
                  </a>
                </div>
                <button
                  onClick={() => {
                    const nextStep = currentStep + 1;
                    // Use the explicit function to process the next step
                    processNextStep(flowData, nextStep);
                  }}
                  className="btn-primary"
                >
                  Next Step
                </button>
              </div>
            );
          } else {
            // No signature required or other case
            // Show success and proceed to next step with button
            setStatus(
              <div className="text-center">
                <h3 className="text-xl font-semibold mb-4">Step Completed</h3>
                <div className="bg-green-100 p-4 rounded-lg mb-4">
                  <p className="text-green-800">✅ Step completed successfully!</p>
                </div>
                <button
                  onClick={() => {
                    const nextStep = currentStep + 1;
                    // Use the explicit function to process the next step
                    processNextStep(flowData, nextStep);
                  }}
                  className="btn-primary"
                >
                  Next Step
                </button>
              </div>
            );
          }
          
          return; // Exit this iteration, the next step will be handled when user clicks the Next Step button
        } else {
          // Show error
          setStatus(
            <div className="text-center">
              <h3 className="text-xl font-semibold mb-4 text-red-600">Step Failed</h3>
              <div className="bg-red-50 p-4 rounded-lg mb-4">
                <p className="text-red-700">Failed to execute step {currentStep}.</p>
                <p className="text-sm text-gray-600 mt-2">{result.error}</p>
              </div>
              <button
                onClick={() => processRemittanceFlow(flowData, currentStep)}
                className="btn-primary"
              >
                Try Again
              </button>
            </div>
          );
          return; // Exit and wait for user to try again
        }
      };
      
      // Wait for the async operation to complete before continuing
      return;
    }
    
    // If we've reached here, all steps are complete
    if (currentStep > totalSteps) {
      setStatus(
        <div className="text-center">
          <h3 className="text-xl font-semibold mb-4">Remittance Complete</h3>
          <div className="bg-green-100 p-4 rounded-lg mb-4">
            <p className="text-green-800">
              ✅ Remittance process completed successfully!
            </p>
            {flowData.using_test_tokens && (
              <p className="text-sm mt-2">
                You now have tEUR tokens in your wallet representing the euros that would
                be sent to the recipient in a real remittance.
              </p>
            )}
          </div>
          
          {/* Display final token balances */}
          {Object.keys(tokenBalances).length > 0 && (
            <div className="mt-4 p-4 bg-gray-900 rounded-lg border border-gray-800">
              <h4 className="text-primary font-medium mb-2">Final Token Balances</h4>
              <div className="grid grid-cols-2 gap-2">
                {Object.values(tokenBalances).map((token) => (
                  <div key={token.address} className="flex justify-between items-center">
                    <span>{token.symbol}:</span>
                    <span className="font-mono">{parseFloat(token.balance).toFixed(4)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          <button
            onClick={() => {
              // Clear remittance data from localStorage when done
              localStorage.removeItem("brinco_remittance_flow");
              setRemittanceFlowData(null);
              setCurrentRemittanceStep(1);
              setShowStatusPopup(false);
            }}
            className="btn-primary mt-4"
          >
            Done
          </button>
        </div>
      );
    }
  };

  // Modify queryIntent to include the test token parameter and handle remittance
  const queryIntent = async () => {
    setNetworkError(null);
    let data: any;
    setLoading(true);
    try {
      const response = await fetch(`${BACKEND_URL}answer/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ 
          question: intentValue,
          use_test_tokens: true // Always use test tokens
        }),
      });
      if (!response.ok) {
        throw new Error("Network response was not ok!");
      }
      data = await response.json();
    } catch (error) {
      console.error("Failed to fetch:", error);
      setStatus(
        <div className="text-center">
          <h3 className="text-xl font-semibold mb-4 text-red-600">Request Failed</h3>
          <div className="bg-red-50 p-4 rounded-lg">
            <p className="text-red-700">Failed to process your request. Please check your internet connection.</p>
          </div>
        </div>
      );
      setShowStatusPopup(true);
      setLoading(false);
      return;
    }

    if (data.transaction_type === "transfer") {
      const { recipientAddress, chain, amount, token } = data.response;
      try {
        // Check network connectivity first
        await checkNetwork(chain);
        
        // Add to history as pending
        const historyId = `tx-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        addTransactionToHistory({
          type: "transfer",
          status: "pending",
          data: { 
            chain, 
            amount: amount.toString(), 
            recipientAddress,
          },
          message: `Preparing to transfer ${amount} tokens to ${recipientAddress} on ${chain}...`,
        });
        
        // Try to execute the transaction
        try {
          const tx: ethers.providers.TransactionResponse = await sendTransaction(
            wallets,
            recipientAddress,
            amount.toString(),
            chain,
            token
          );
          
          // Update history with transaction hash
          updateTransactionInHistory(historyId, {
            status: "pending",
            data: { transactionHash: tx.hash },
            message: `Transfer of ${amount} tokens to ${recipientAddress} submitted. Awaiting confirmation...`,
          });
          
          setStatus(
            <div className="text-center">
              <h3 className="text-xl font-semibold mb-4">Transfer Submitted</h3>
              <div className="bg-secondary/20 p-4 rounded-lg mb-4">
                <p className="mb-2">Transaction is being processed by the network.</p>
                <a
                  className="text-primary hover:text-primary/80 underline"
                  href={`${chainToUrl[chain]}${tx.hash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on Explorer: {abbreviateTransactionHash(tx.hash || '')}
                </a>
              </div>
            </div>
          );
          setShowStatusPopup(true);

          // Wait for confirmation
          try {
            const receipt = await tx.wait(1);
            
            // Update history to completed
            updateTransactionInHistory(historyId, {
              status: "completed",
              data: { transactionHash: receipt.transactionHash },
              message: `Successfully transferred ${amount} tokens to ${recipientAddress}. View on explorer: ${abbreviateTransactionHash(receipt.transactionHash || '')}`,
            });

            setStatus(
              <div className="text-center">
                <h3 className="text-xl font-semibold mb-4">Transfer Complete</h3>
                <div className="bg-green-100 p-4 rounded-lg mb-4">
                  <p className="text-green-800 mb-2">✅ Your transfer has been confirmed!</p>
                  <a
                    className="text-primary hover:text-primary/80 underline"
                    href={`${chainToUrl[chain]}${receipt.transactionHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on Explorer: {abbreviateTransactionHash(receipt.transactionHash || '')}
                  </a>
                </div>
              </div>
            );
          } catch (confirmError) {
            console.error("Transaction confirmation failed:", confirmError);
            
            // Even if confirmation monitoring fails, the transaction might still go through
            updateTransactionInHistory(historyId, {
              status: "pending",
              message: `Transfer submitted but confirmation status unknown. View on explorer: ${abbreviateTransactionHash(tx.hash || '')}`,
            });
            
            setStatus(
              <div className="text-center">
                <h3 className="text-xl font-semibold mb-4 text-yellow-600">Confirmation Status Unknown</h3>
                <div className="bg-yellow-50 p-4 rounded-lg mb-4">
                  <p className="text-yellow-800 mb-2">Your transaction was submitted, but we couldn't monitor its status.</p>
                  <p className="mb-2">Please check the transaction status on the blockchain explorer:</p>
                  <a
                    className="text-primary hover:text-primary/80 underline"
                    href={`${chainToUrl[chain]}${tx.hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on Explorer: {abbreviateTransactionHash(tx.hash || '')}
                  </a>
                </div>
              </div>
            );
          }
        } catch (txError: any) {
          console.error("Transaction execution failed:", txError);
          
          // Handle ENS resolution errors specifically
          if (txError.message && (
              txError.message.includes("Could not resolve name") || 
              txError.message.includes("invalid address") ||
              txError.message.includes("ENS")
          )) {
            updateTransactionInHistory(historyId, {
              status: "failed",
              message: `Transfer failed: Could not resolve recipient address "${recipientAddress}"`,
            });
            
            setStatus(
              <div className="text-center">
                <h3 className="text-xl font-semibold mb-2 text-red-600">Address Resolution Failed</h3>
                <div className="bg-red-50 p-4 rounded-lg">
                  <p className="mb-4">We couldn't resolve the recipient address.</p>
                  <p className="text-sm text-gray-600">{txError.message}</p>
                  <div className="mt-4 p-4 bg-yellow-50 rounded-lg">
                    <p className="text-sm text-yellow-800">
                      📝 Suggestions:
                      <ul className="list-disc list-inside mt-2">
                        <li>Check if the ENS name is correct</li>
                        <li>Try using the full Ethereum address instead</li>
                        <li>There might be network issues with the ENS resolution service</li>
                      </ul>
                    </p>
                  </div>
                </div>
              </div>
            );
            setShowStatusPopup(true);
            setLoading(false);
            return;
          }
          
          if (txError.message && txError.message.includes("user rejected")) {
            updateTransactionInHistory(historyId, {
              status: "failed",
              message: `Transfer was cancelled: You rejected the transaction in your wallet`,
            });
            
            setStatus(
              <div className="text-center">
                <h3 className="text-xl font-semibold mb-2 text-yellow-600">Transaction Cancelled</h3>
                <div className="bg-yellow-50 p-4 rounded-lg">
                  <p>You rejected the transaction in your wallet.</p>
                </div>
              </div>
            );
            setShowStatusPopup(true);
            setLoading(false);
            return;
          }
          
          // Re-throw for general error handling
          throw txError;
        }
        
        setLoading(false);
      } catch (error) {
        console.error("Transfer failed:", error);
        
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        setNetworkError(errorMessage);
        
        // Add failed transaction to history
        addTransactionToHistory({
          type: "transfer",
          status: "failed",
          data: { 
            chain, 
            amount: amount.toString(), 
            recipientAddress 
          },
          message: `Transfer failed: ${errorMessage}`,
        });
        
        // Build a helpful error message based on the error type
        let title = "Transfer Failed";
        let content = <p className="mb-4">Unable to complete the transfer.</p>;
        let tips = null;
        
        if (errorMessage.includes('network')) {
          title = "Network Connection Failed";
          tips = (
            <div className="mt-4 p-4 bg-yellow-50 rounded-lg">
              <p className="text-sm text-yellow-800">
                📝 Tips:
                <ul className="list-disc list-inside mt-2">
                  <li>Check your internet connection</li>
                  <li>Make sure your wallet is connected to the {chain} network</li>
                  <li>Try refreshing the page</li>
                </ul>
              </p>
            </div>
          );
        } else if (errorMessage.includes('insufficient') || errorMessage.includes('funds')) {
          title = "Insufficient Funds";
          content = <p className="mb-4">You don't have enough funds to complete this transfer.</p>;
          tips = (
            <div className="mt-4 p-4 bg-yellow-50 rounded-lg">
              <p className="text-sm text-yellow-800">
                📝 Tips:
                <ul className="list-disc list-inside mt-2">
                  <li>Make sure you have enough tokens in your wallet</li>
                  <li>Consider network fees when transferring</li>
                </ul>
              </p>
            </div>
          );
        }
        
        setStatus(
          <div className="text-center">
            <h3 className="text-xl font-semibold mb-2 text-red-600">{title}</h3>
            <div className="bg-red-50 p-4 rounded-lg">
              {content}
              <p className="text-sm text-gray-600">{errorMessage}</p>
              {tips}
            </div>
          </div>
        );
        setShowStatusPopup(true);
        setLoading(false);
      }
    } else if (data.transaction_type === "swap") {
      const { chain, amount, fromAsset, toAsset } = data.response;
      try {
        // Check network connectivity first
        await checkNetwork(chain);
        
        // Add to history as pending
        const historyId = `tx-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        addTransactionToHistory({
          type: "swap",
          status: "pending",
          data: { 
            chain, 
            amount: amount.toString(), 
            fromAsset,
            toAsset
          },
          message: `Swapping ${amount} from ${fromAsset.substring(0, 6)}... to ${toAsset.substring(0, 6)}... on ${chain}...`,
        });
        
        if (chain === "sepolia") {
          const txHash = await uniswapV2Swap(
            wallets,
            chain,
            fromAsset,
            toAsset,
            amount.toString()
          );
          
          // Update history with transaction hash
          updateTransactionInHistory(historyId, {
            status: "pending",
            data: { transactionHash: txHash },
            message: `Swap of ${amount} tokens submitted. Awaiting confirmation... View on explorer: ${abbreviateTransactionHash(txHash || '')}`,
          });
          
          setStatus(
            <div className="text-center">
              <h3 className="text-xl font-semibold mb-4">Swap Submitted</h3>
              <div className="bg-secondary/20 p-4 rounded-lg mb-4">
                <p className="mb-2">Your swap transaction is being processed by the network.</p>
                <a
                  className="text-primary hover:text-primary/80 underline"
                  href={`${chainToUrl[chain]}${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on Explorer: {abbreviateTransactionHash(txHash || '')}
                </a>
              </div>
            </div>
          );
          setShowStatusPopup(true);
          
          // Wait for transaction confirmation
          const provider = await wallets[0]?.getEthersProvider();
          if (!provider) {
            throw new Error("No wallet provider available");
          }
          const receipt = await provider.waitForTransaction(txHash);
          
          // Update history to completed
          updateTransactionInHistory(historyId, {
            status: "completed",
            data: { transactionHash: receipt.transactionHash },
            message: `Successfully swapped ${amount} tokens on ${chain}! View on explorer: ${abbreviateTransactionHash(receipt.transactionHash || '')}`,
          });
          
          setStatus(
            <div className="text-center">
              <h3 className="text-xl font-semibold mb-4">Swap Complete</h3>
              <div className="bg-green-100 p-4 rounded-lg mb-4">
                <p className="text-green-800 mb-2">✅ Your swap has been confirmed!</p>
                <a
                  className="text-primary hover:text-primary/80 underline"
                  href={`${chainToUrl[chain]}${receipt.transactionHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on Explorer: {abbreviateTransactionHash(receipt.transactionHash || '')}
                </a>
              </div>
            </div>
          );
          setLoading(false);
        } else {
          // Use COW Protocol for other chains
          const orderId = await sendOrder(
            wallets,
            chain,
            fromAsset,
            toAsset,
            amount.toString()
          );
          
          // Update history with order ID
          updateTransactionInHistory(historyId, {
            status: "pending",
            data: { orderId },
            message: `Swap order ${orderId.substring(0, 8)}... submitted. Waiting for fill...`,
          });
          
          setStatus(
            <div className="text-center">
              <h3 className="text-xl font-semibold mb-4">Order Submitted</h3>
              <div className="bg-secondary/20 p-4 rounded-lg">
                <p>Your order has been sent to COW Protocol and is being processed.</p>
                <p className="text-sm mt-2">Order ID: {orderId.substring(0, 12)}...</p>
              </div>
            </div>
          );
          setShowStatusPopup(true);

          const orderStatus = await waitForOrderStatus(orderId, chain);
          
          if (orderStatus === OrderStatus.FULFILLED) {
            // Update history to completed
            updateTransactionInHistory(historyId, {
              status: "completed",
              message: `Successfully swapped ${amount} tokens via COW Protocol. Order: ${orderId.substring(0, 8)}...`,
            });
            
            setStatus(
              <div className="text-center">
                <h3 className="text-xl font-semibold mb-4">Order Filled</h3>
                <div className="bg-green-100 p-4 rounded-lg">
                  <p className="text-green-800">✅ Your swap order has been successfully filled!</p>
                </div>
              </div>
            );
          } else {
            // Update history to failed
            updateTransactionInHistory(historyId, {
              status: "failed",
              message: `Swap order failed with status: ${orderStatus}`,
            });
            
            setStatus(
              <div className="text-center">
                <h3 className="text-xl font-semibold mb-4 text-red-600">Order Failed</h3>
                <div className="bg-red-50 p-4 rounded-lg">
                  <p className="text-red-700">Something went wrong with your order.</p>
                  <p className="text-sm mt-2">Status: {orderStatus}</p>
                </div>
              </div>
            );
          }
          setLoading(false);
        }
      } catch (error: any) {
        console.error("Swap failed:", error);
        
        // Add failed transaction to history
        addTransactionToHistory({
          type: "swap",
          status: "failed",
          data: { 
            chain, 
            amount: amount.toString(), 
            fromAsset,
            toAsset 
          },
          message: `Swap of ${amount} tokens failed: ${error.message || 'Unknown error'}`,
        });
        
        let errorMessage = "Sorry, there was an issue processing your swap.";
        
        if (error.message && error.message.includes("NoLiquidity")) {
          errorMessage = "Sorry, there is no liquidity available for this swap pair. Please try a different token pair.";
        } else if (error.message && error.message.includes("Insufficient liquidity")) {
          errorMessage = "Sorry, there is insufficient liquidity for this swap pair on Uniswap. Please try a different token pair.";
        } else if (error.message && error.message.includes("No liquidity available")) {
          errorMessage = "Sorry, there is no liquidity available for this swap pair on Uniswap V2. Please try a different token pair.";
        } else if (error.message && error.message.includes("COWProtocolUnsupported")) {
          errorMessage = "Sorry, COW Protocol doesn't support swaps on the Sepolia testnet. Please try using a different network like Ethereum Mainnet.";
        } else if (error.message && (error.message.includes("404") || error.message.includes("Not Found"))) {
          errorMessage = "Sorry, COW Protocol API endpoint not found. The Sepolia testnet is not supported by COW Protocol.";
        } else if (error.message && error.message.includes("user rejected transaction")) {
          errorMessage = "Transaction was rejected in your wallet.";
        } else if (error.message) {
          errorMessage = error.message;
        }
        
        setStatus(
          <div className="text-center">
            <h3 className="text-xl font-semibold mb-4 text-red-600">Swap Failed</h3>
            <div className="bg-red-50 p-4 rounded-lg">
              <p className="text-red-700">{errorMessage}</p>
              {error.message && error.message.includes("liquidity") && (
                <p className="text-sm mt-2 text-gray-600">
                  This may be due to insufficient liquidity between these tokens on the {chain} network.
                </p>
              )}
            </div>
          </div>
        );
        setShowStatusPopup(true);
        setLoading(false);
      }
    } else if (data.transaction_type === "buy") {
      const { cryptoAsset, amount, chain, paymentMethod } = data.response;
      try {
        // Check network connectivity first
        await checkNetwork(chain);
        
        // Add to history as pending
        const historyId = `tx-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        addTransactionToHistory({
          type: "buy",
          status: "pending",
          data: { 
            chain, 
            amount: amount.toString(), 
            toAsset: cryptoAsset,
          },
          message: `Initiating purchase of ${amount} ${cryptoAsset.substring(0, 8)}... on ${chain} using ${paymentMethod}`,
        });
        
        // Process the buy request using MoonPay
        const { moonpayUrl } = await processBuyRequest(
          wallets,
          amount.toString(),
          cryptoAsset,
          chain,
          paymentMethod
        );
        
        // Update history with moonpay URL
        updateTransactionInHistory(historyId, {
          status: "completed",
          data: { moonpayUrl },
          message: `MoonPay purchase request for ${amount} initiated successfully. Complete the purchase in MoonPay.`,
        });
        
        // Open the MoonPay widget in a new tab
        window.open(moonpayUrl, "_blank");
        
        setStatus(
          <div className="text-center space-y-6">
            <h3 className="text-xl font-semibold">Buy {amount} USDC with MoonPay</h3>
            
            <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm text-left">
              <p className="mb-4">We've opened MoonPay in a new tab where you can complete your purchase.</p>
              
              <ol className="list-decimal list-inside space-y-3">
                <li className="pb-2">Complete the checkout process in the MoonPay tab</li>
                <li className="pb-2">Your wallet address has been pre-filled for you</li>
                <li className="pb-2">Select your preferred payment method: {paymentMethod.replace('_', ' ')}</li>
                <li className="pb-2">Follow the prompts to complete KYC if required</li>
                <li>Once complete, USDC will be sent directly to your wallet</li>
              </ol>
            </div>
            
            <div className="bg-secondary/20 p-4 rounded-lg text-gray-800 text-sm">
              <p className="font-medium mb-1">💡 About MoonPay</p>
              <p>MoonPay is a trusted fiat-to-crypto service that makes buying cryptocurrency simple and secure. They handle all regulatory requirements and offer competitive rates.</p>
            </div>
            
            {chain !== 'mainnet' && (
              <div className="bg-yellow-50 p-4 rounded-lg text-yellow-800 text-sm">
                <p className="font-medium mb-1">⚠️ Testnet Notice</p>
                <p>You're currently on {chain} testnet. For testing purposes, the MoonPay widget will be configured to purchase on testnet, but actual testnet purchases may not be supported by all providers.</p>
              </div>
            )}
          </div>
        );
        setShowStatusPopup(true);
        setLoading(false);
      } catch (error: any) {
        console.error("Buy transaction failed:", error);
        
        // Add failed transaction to history
        addTransactionToHistory({
          type: "buy",
          status: "failed",
          data: { 
            chain, 
            amount: amount.toString(), 
            toAsset: cryptoAsset
          },
          message: `Purchase of ${amount} ${cryptoAsset.substring(0, 8)}... failed: ${error.message || 'Unknown error'}`,
        });
        
        setStatus(
          <div className="text-center">
            <h3 className="text-xl font-semibold mb-4 text-red-600">Purchase Failed</h3>
            <div className="bg-red-50 p-4 rounded-lg">
              <p className="text-red-700 mb-4">Sorry, we couldn't process your purchase request.</p>
              <p className="text-sm text-gray-600">
                {error.message || "Unknown error"}
              </p>
              <p className="mt-4">Please try again later or use your wallet's built-in "Buy" feature.</p>
            </div>
          </div>
        );
        setShowStatusPopup(true);
        setLoading(false);
      }
    } else if (data.transaction_type === "remittance") {
      const { amount, recipient_address, chain } = data.response;
      
      try {
        // Check network connectivity first
        await checkNetwork(chain);
        
        console.log("🔄 Starting new remittance process - clearing previous data");
        // IMPORTANT: Clear any existing remittance flow data from localStorage
        localStorage.removeItem("brinco_remittance_flow");
        
        console.log("⬆️ Resetting to step 1");
        // Reset the current step to 1 and clear any previous remittance data
        setCurrentRemittanceStep(1);
        
        // Store the remittance flow data for processing
        setRemittanceFlowData(data.response);
        
        // Store the remittance cost simulation data
        if (data.response.cost_simulation) {
          setRemittanceCost(data.response.cost_simulation);
          setShowCostSimulation(true);
        }
        
        // Add to history as pending
        const historyId = `tx-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        addTransactionToHistory({
          type: "remittance",
          status: "pending",
          data: { 
            chain, 
            amount: amount.toString(), 
            recipientAddress: recipient_address,
            exchangeRates: data.response.cost_simulation?.exchange_rates,
            fees: data.response.cost_simulation?.fees
          },
          message: `Starting remittance of $${amount} to ${recipient_address} on ${chain}...`,
        });
        
        // Get the transaction flow steps
        const transactionFlow = data.response.transaction_flow;
        const totalSteps = Object.keys(transactionFlow).length;
        
        // If using test tokens, check initial balances
        if (data.response.using_test_tokens && data.response.token_addresses && wallets[0]?.address) {
          await checkTokenBalance(data.response.token_addresses.tUSD, wallets[0].address);
          await checkTokenBalance(data.response.token_addresses.tEUR, wallets[0].address);
        }
        
        setStatus(
          <div className="text-center">
            <h3 className="text-xl font-semibold mb-4">Remittance Process</h3>
            <div className="bg-secondary/20 p-4 rounded-lg mb-4">
              <p className="mb-2">Remittance flow initialized with {totalSteps} steps.</p>
              {data.response.using_test_tokens && (
                <p className="text-yellow-400 text-sm mb-2">Using test tokens (tUSD and tEUR) for simulation.</p>
              )}
              <div className="mt-4">
                <button 
                  onClick={() => setShowCostSimulation(!showCostSimulation)}
                  className="text-primary hover:text-primary/80 underline"
                >
                  {showCostSimulation ? "Hide Cost Simulation" : "Show Cost Simulation"}
                </button>
              </div>
            </div>
            
            {showCostSimulation && remittanceCost && (
              <div className="bg-gray-900 p-4 rounded-lg border border-gray-700 text-left mt-4">
                <h4 className="text-lg font-medium text-primary mb-2">Remittance Cost Simulation</h4>
                
                <div className="grid grid-cols-2 gap-2 mt-4">
                  <div className="text-gray-400">USD Amount:</div>
                  <div className="text-right font-mono">${remittanceCost.usd_amount.toFixed(2)}</div>
                  
                  <div className="text-gray-400">EUR Amount:</div>
                  <div className="text-right font-mono">€{remittanceCost.eur_amount.toFixed(2)}</div>
                  
                  <div className="text-gray-400">Exchange Rate:</div>
                  <div className="text-right font-mono">
                    1 USD ≈ {remittanceCost.exchange_rates.usdc_to_eurc.toFixed(4)} EUR
                  </div>
                  
                  <div className="text-gray-400">Network Fee:</div>
                  <div className="text-right font-mono">${remittanceCost.fees.network_fee_usd.toFixed(2)}</div>
                  
                  <div className="text-gray-400">Service Fee:</div>
                  <div className="text-right font-mono">${remittanceCost.fees.service_fee_usd.toFixed(2)}</div>
                  
                  <div className="text-gray-400 font-medium">Total Cost:</div>
                  <div className="text-right font-mono font-medium">${remittanceCost.fees.total_cost_usd.toFixed(2)}</div>
                </div>
                
                <div className="mt-4 pt-4 border-t border-gray-700">
                  <p className="text-sm text-gray-400">
                    Cost simulation based on current market rates and estimated gas prices. 
                    Actual costs may vary at the time of execution.
                  </p>
                </div>
              </div>
            )}
            
            {/* Display token balances if available */}
            {Object.keys(tokenBalances).length > 0 && (
              <div className="mt-4 p-4 bg-gray-900 rounded-lg border border-gray-800">
                <h4 className="text-primary font-medium mb-2">Token Balances</h4>
                <div className="grid grid-cols-2 gap-2">
                  {Object.values(tokenBalances).map((token) => (
                    <div key={token.address} className="flex justify-between items-center">
                      <span>{token.symbol}:</span>
                      <span className="font-mono">{parseFloat(token.balance).toFixed(4)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            <div className="mt-6">
              <button
                onClick={() => {
                  // Clear any existing flow data to ensure we start fresh
                  localStorage.removeItem("brinco_remittance_flow");
                  // Reset to step 1
                  setCurrentRemittanceStep(1);
                  // Show the process in the popup
                  setShowStatusPopup(true);
                  // Wait a bit to ensure state is updated before processing
                  setTimeout(() => {
                    processRemittanceFlow(data.response, 1);
                  }, 100);
                }}
                className="btn-primary"
              >
                Begin Remittance Process
              </button>
            </div>
          </div>
        );
        setShowStatusPopup(true);
        setLoading(false);
      } catch (error) {
        console.error("Remittance failed:", error);
        
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        setNetworkError(errorMessage);
        
        // Add failed transaction to history
        addTransactionToHistory({
          type: "remittance",
          status: "failed",
          data: { 
            chain, 
            amount: amount.toString(), 
            recipientAddress: recipient_address 
          },
          message: `Remittance failed: ${errorMessage}`,
        });
        
        setStatus(
          <div className="text-center">
            <h3 className="text-xl font-semibold mb-2 text-red-600">Remittance Failed</h3>
            <div className="bg-red-50 p-4 rounded-lg">
              <p className="mb-4">Unable to complete the remittance process.</p>
              <p className="text-sm text-gray-600">{errorMessage}</p>
            </div>
          </div>
        );
        setShowStatusPopup(true);
        setLoading(false);
      }
    }
    
    // Clear the input after processing
    setIntentValue("");
  };

  // Helper function to get appropriate color for transaction status
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'text-status-success';
      case 'pending': return 'text-status-pending';
      case 'failed': return 'text-status-error';
      default: return 'text-gray-400';
    }
  };

  const getTransactionIcon = (type: string) => {
    switch (type) {
      case 'transfer': return '↗️';
      case 'swap': return '🔄';
      case 'buy': return '💰';
      case 'remittance': return '💸';
      default: return '📝';
    }
  };

  // Format timestamp to readable date
  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  return (
    <>
      <Head>
        <title>Brinco</title>
      </Head>

      <main className="flex flex-col items-center justify-center min-h-screen px-4 sm:px-20 bg-background text-text">
        {ready && authenticated && (
          <div className="bg-card rounded-xl overflow-hidden border border-gray-800 shadow-xl w-full max-w-3xl">
            {/* Header with window dots */}
            <div className="flex justify-between items-center p-4 border-b border-gray-800 bg-card-header">
              <div className="flex items-center gap-2">
                <div className="window-dot window-dot-red"></div>
                <div className="window-dot window-dot-yellow"></div>
                <div className="window-dot window-dot-green"></div>
              </div>
              <div className="text-primary font-mono text-xs tracking-wider">BRINCO AGENT</div>
              <button
                onClick={logout}
                className="text-gray-400 hover:text-gray-200 hover:bg-gray-800 px-4 py-2 rounded-md text-sm flex items-center transition"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                  <polyline points="16 17 21 12 16 7"></polyline>
                  <line x1="21" y1="12" x2="9" y2="12"></line>
                </svg>
                Logout
              </button>
            </div>

            {networkError && (
              <div className="m-4 p-4 bg-[#2d1e1e] rounded-lg border border-status-error/30">
                <p className="text-status-error">{networkError}</p>
              </div>
            )}

            {showStatusPopup ? (
              <div className="flex flex-col items-center justify-between p-6">
                {status}
                <div className="flex flex-row items-center mt-6">
                  <button
                    onClick={() => setShowStatusPopup(false)}
                    className="btn-primary"
                  >
                    OK
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-6 space-y-6">
                {/* Greeting */}
                <div className="text-center">
                  <h2 className="text-xl font-light text-primary">
                    {userName ? `Hi ${userName}` : 'Welcome'}, I'm Brinco your remittance agent
                  </h2>
                </div>

                {/* Message input */}
                <div className="space-y-3">
                  <textarea
                    value={intentValue}
                    onChange={(e) => setIntentValue(e.target.value)}
                    placeholder="How can I help you today? I support transfers, swaps, and cross border remittance simulations through your wallet."
                    className="custom-textarea"
                  />
                  <div className="flex justify-between items-center">
                    <div className="flex items-center">
                      {/* Removed the checkbox for using test tokens */}
                    </div>
                    <button
                      onClick={queryIntent}
                      className={`btn-primary ${loading ? "opacity-70 cursor-not-allowed" : ""}`}
                      disabled={loading}
                    >
                      {loading ? (
                        "Processing..."
                      ) : (
                        <>
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="22" y1="2" x2="11" y2="13"></line>
                            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                          </svg>
                          Submit
                        </>
                      )}
                    </button>
                  </div>
                </div>
                
                {/* Transaction History Dropdown Section */}
                {transactionHistory.length > 0 && (
                  <div className="w-full border border-gray-800 rounded-lg overflow-hidden">
                    <button 
                      onClick={() => setShowHistory(!showHistory)}
                      className="transaction-history-header"
                    >
                      <div className="flex items-center">
                        <span className="text-primary font-medium">Transaction History</span>
                        {transactionHistory.length > 0 && (
                          <span className="ml-2 bg-primary text-white text-xs rounded-full h-5 w-5 flex items-center justify-center">
                            {transactionHistory.length}
                          </span>
                        )}
                      </div>
                      <svg 
                        xmlns="http://www.w3.org/2000/svg" 
                        className={`h-4 w-4 text-gray-400 transition-transform duration-200 ${showHistory ? 'transform rotate-180' : ''}`}
                        viewBox="0 0 24 24" 
                        fill="none" 
                        stroke="currentColor" 
                        strokeWidth="2" 
                        strokeLinecap="round" 
                        strokeLinejoin="round"
                      >
                        <polyline points="6 9 12 15 18 9"></polyline>
                      </svg>
                    </button>
                    
                    {/* Collapsible history content */}
                    <div className={`overflow-hidden transition-all duration-300 ease-in-out ${showHistory ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'}`}>
                      <div className="divide-y divide-gray-800">
                        {transactionHistory.map((tx) => (
                          <div key={tx.id} className="transaction-item">
                            <div>
                              <div className="flex items-center">
                                <span className="mr-2">{getTransactionIcon(tx.type)}</span>
                                <span className="font-medium">{tx.type}</span>
                              </div>
                              <div className="text-sm text-gray-400 mt-1">
                                {formatTimestamp(tx.timestamp)}
                              </div>
                            </div>
                            
                            <div className="text-right">
                              <div className="font-mono">{tx.data.amount}</div>
                              <div className={`text-xs ${getStatusColor(tx.status)}`}>
                                {tx.status === 'completed' ? 'Succeeded' : tx.status}
                              </div>
                              
                              {/* Show transaction hash link if available */}
                              {tx.data.transactionHash && tx.data.chain && (
                                <a 
                                  href={`${chainToUrl[tx.data.chain]}${tx.data.transactionHash}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-xs text-primary hover:underline mt-1 inline-flex items-center"
                                >
                                  <span className="mr-1">Explorer:</span>
                                  {abbreviateTransactionHash(tx.data.transactionHash || '')}
                                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                  </svg>
                                </a>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </>
  );
}
