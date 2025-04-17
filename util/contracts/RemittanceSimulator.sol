// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title MockStablecoin
 * @dev A mock stablecoin token implementation for testing remittance flows
 */
contract MockStablecoin is ERC20, Ownable {
    uint8 private _decimals;
    
    constructor(string memory name_, string memory symbol_, uint8 decimals_) 
        ERC20(name_, symbol_) 
        Ownable(msg.sender) 
    {
        _decimals = decimals_;
    }
    
    function decimals() public view override returns (uint8) {
        return _decimals;
    }
    
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
    
    function burn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }
}

/**
 * @title RemittanceSimulator
 * @dev A complete simulation of cross-border remittance using USD→USDC→EURC→EUR flow
 */
contract RemittanceSimulator is Ownable, ReentrancyGuard {
    // Token contracts
    MockStablecoin public usdcToken;
    MockStablecoin public eurcToken;
    
    // Exchange rates (with 6 decimals)
    uint256 public usdToEurRate = 920000; // 0.92 EUR per USD
    
    // Fees (basis points, 1 bp = 0.01%)
    uint256 public buyFeeBps = 100;   // 1.0% fee for buying USDC
    uint256 public swapFeeBps = 50;   // 0.5% fee for swapping USDC to EURC
    uint256 public sellFeeBps = 100;  // 1.0% fee for selling EURC for EUR
    
    // Remittance tracking
    struct RemittanceRecord {
        address sender;
        string recipient;
        uint256 sourceAmount;
        uint256 destinationAmount;
        string sourceCurrency;
        string destinationCurrency;
        string destinationCountry;
        uint256 timestamp;
        RemittanceStatus status;
    }
    
    enum RemittanceStatus { Pending, Completed, Failed }
    
    // Gas tracking for each operation
    struct GasMetrics {
        uint256 buyGasUsed;
        uint256 swapGasUsed;
        uint256 sellGasUsed;
        uint256 totalGasUsed;
        uint256 gasPriceWei;
    }
    
    // Storage for remittance records
    mapping(bytes32 => RemittanceRecord) public remittances;
    mapping(bytes32 => GasMetrics) public gasMetrics;
    bytes32[] public remittanceIds;
    
    // Events
    event RemittanceInitiated(
        bytes32 indexed remittanceId,
        address indexed sender,
        string recipient,
        uint256 sourceAmount,
        string destinationCountry
    );
    
    event USDCMinted(address indexed user, uint256 amount, uint256 fee);
    event USDCSwappedToEURC(address indexed user, uint256 usdcAmount, uint256 eurcAmount, uint256 fee);
    event EURCSold(address indexed user, uint256 eurcAmount, uint256 eurAmount, uint256 fee, string recipient);
    event RemittanceCompleted(bytes32 indexed remittanceId, uint256 finalAmount);
    event RemittanceFailed(bytes32 indexed remittanceId, string reason);
    
    event GasUsed(string operation, uint256 gasUsed, uint256 gasPriceWei);
    
    constructor() Ownable(msg.sender) {
        // Deploy mock stablecoins
        usdcToken = new MockStablecoin("USD Coin", "USDC", 6);
        eurcToken = new MockStablecoin("Euro Coin", "EURC", 6);
    }
    
    /**
     * @dev Update exchange rate between USD and EUR
     * @param newRate New exchange rate (e.g., 920000 = 0.92 with 6 decimals)
     */
    function updateExchangeRate(uint256 newRate) external onlyOwner {
        usdToEurRate = newRate;
    }
    
    /**
     * @dev Update fees
     * @param newBuyFeeBps New buy fee in basis points
     * @param newSwapFeeBps New swap fee in basis points
     * @param newSellFeeBps New sell fee in basis points
     */
    function updateFees(
        uint256 newBuyFeeBps, 
        uint256 newSwapFeeBps, 
        uint256 newSellFeeBps
    ) external onlyOwner {
        require(newBuyFeeBps <= 1000, "Buy fee cannot exceed 10%");
        require(newSwapFeeBps <= 1000, "Swap fee cannot exceed 10%");
        require(newSellFeeBps <= 1000, "Sell fee cannot exceed 10%");
        
        buyFeeBps = newBuyFeeBps;
        swapFeeBps = newSwapFeeBps;
        sellFeeBps = newSellFeeBps;
    }
    
    /**
     * @dev Simulate buying USDC with USD (fiat on-ramp)
     * @param user Address to receive the USDC
     * @param usdAmount Amount of USD to convert (with 6 decimals)
     * @return mintedAmount Amount of USDC minted after fees
     */
    function buyUSDC(address user, uint256 usdAmount) external nonReentrant returns (uint256 mintedAmount) {
        // Track starting gas
        uint256 startGas = gasleft();
        
        require(user != address(0), "Invalid user address");
        require(usdAmount > 0, "Amount must be positive");
        
        // Calculate fee and amount to mint
        uint256 fee = (usdAmount * buyFeeBps) / 10000;
        mintedAmount = usdAmount - fee;
        
        // Mint USDC to the user
        usdcToken.mint(user, mintedAmount);
        
        emit USDCMinted(user, mintedAmount, fee);
        
        // Track gas used
        uint256 gasUsed = startGas - gasleft();
        emit GasUsed("buyUSDC", gasUsed, tx.gasprice);
        
        return mintedAmount;
    }
    
    /**
     * @dev Swap USDC to EURC
     * @param user Address of the user performing the swap
     * @param usdcAmount Amount of USDC to swap (with 6 decimals)
     * @return eurcAmount Amount of EURC received after conversion and fees
     */
    function swapUSDCtoEURC(address user, uint256 usdcAmount) external nonReentrant returns (uint256 eurcAmount) {
        // Track starting gas
        uint256 startGas = gasleft();
        
        require(user != address(0), "Invalid user address");
        require(usdcAmount > 0, "Amount must be positive");
        
        // Transfer USDC from user to contract
        require(usdcToken.transferFrom(user, address(this), usdcAmount), "USDC transfer failed");
        
        // Calculate EURC amount using exchange rate
        uint256 rawEurcAmount = (usdcAmount * usdToEurRate) / 1000000;
        
        // Calculate fee
        uint256 fee = (rawEurcAmount * swapFeeBps) / 10000;
        eurcAmount = rawEurcAmount - fee;
        
        // Mint EURC to user
        eurcToken.mint(user, eurcAmount);
        
        emit USDCSwappedToEURC(user, usdcAmount, eurcAmount, fee);
        
        // Track gas used
        uint256 gasUsed = startGas - gasleft();
        emit GasUsed("swapUSDCtoEURC", gasUsed, tx.gasprice);
        
        return eurcAmount;
    }
    
    /**
     * @dev Sell EURC for EUR (fiat off-ramp)
     * @param user Address of the user selling EURC
     * @param eurcAmount Amount of EURC to sell (with 6 decimals)
     * @param recipient Identifier for the fiat recipient
     * @return eurAmount Amount of EUR to be received by recipient
     */
    function sellEURC(address user, uint256 eurcAmount, string memory recipient) external nonReentrant returns (uint256 eurAmount) {
        // Track starting gas
        uint256 startGas = gasleft();
        
        require(user != address(0), "Invalid user address");
        require(eurcAmount > 0, "Amount must be positive");
        require(bytes(recipient).length > 0, "Recipient details required");
        
        // Transfer EURC from user to contract
        require(eurcToken.transferFrom(user, address(this), eurcAmount), "EURC transfer failed");
        
        // Calculate fee
        uint256 fee = (eurcAmount * sellFeeBps) / 10000;
        eurAmount = eurcAmount - fee;
        
        // Burn the EURC (off-ramp simulation)
        eurcToken.burn(address(this), eurcAmount);
        
        emit EURCSold(user, eurcAmount, eurAmount, fee, recipient);
        
        // Track gas used
        uint256 gasUsed = startGas - gasleft();
        emit GasUsed("sellEURC", gasUsed, tx.gasprice);
        
        return eurAmount;
    }
    
    /**
     * @dev Process a complete remittance from USD to EUR
     * @param usdAmount Amount of USD to send (with 6 decimals)
     * @param recipient Recipient identifier
     * @param destinationCountry Destination country for the funds
     * @return remittanceId Unique ID for this remittance
     * @return finalEurAmount Final EUR amount after all conversions and fees
     */
    function processRemittance(
        uint256 usdAmount,
        string memory recipient,
        string memory destinationCountry
    ) external nonReentrant returns (bytes32 remittanceId, uint256 finalEurAmount) {
        address sender = msg.sender;
        
        // Create a unique remittance ID
        remittanceId = keccak256(abi.encodePacked(sender, block.timestamp, usdAmount, recipient, destinationCountry));
        
        // Track starting gas
        uint256 startGas = gasleft();
        uint256 buyGasStart = startGas;
        
        // Step 1: Buy USDC with USD
        uint256 usdcAmount = this.buyUSDC(sender, usdAmount);
        
        // Track gas used for buy
        uint256 buyGasUsed = buyGasStart - gasleft();
        
        // Step 2: Swap USDC to EURC
        uint256 swapGasStart = gasleft();
        
        // Approve USDC spending (handled by the user in the real implementation)
        // In this simulation, we proceed with the assumption that approval is done
        
        uint256 eurcAmount = this.swapUSDCtoEURC(sender, usdcAmount);
        
        // Track gas used for swap
        uint256 swapGasUsed = swapGasStart - gasleft();
        
        // Step 3: Sell EURC for EUR
        uint256 sellGasStart = gasleft();
        
        // Approve EURC spending (handled by the user in the real implementation)
        // In this simulation, we proceed with the assumption that approval is done
        
        finalEurAmount = this.sellEURC(sender, eurcAmount, recipient);
        
        // Track gas used for sell
        uint256 sellGasUsed = sellGasStart - gasleft();
        
        // Calculate total gas used
        uint256 totalGasUsed = buyGasUsed + swapGasUsed + sellGasUsed;
        
        // Store gas metrics
        gasMetrics[remittanceId] = GasMetrics({
            buyGasUsed: buyGasUsed,
            swapGasUsed: swapGasUsed,
            sellGasUsed: sellGasUsed,
            totalGasUsed: totalGasUsed,
            gasPriceWei: tx.gasprice
        });
        
        // Store remittance record
        remittances[remittanceId] = RemittanceRecord({
            sender: sender,
            recipient: recipient,
            sourceAmount: usdAmount,
            destinationAmount: finalEurAmount,
            sourceCurrency: "USD",
            destinationCurrency: "EUR",
            destinationCountry: destinationCountry,
            timestamp: block.timestamp,
            status: RemittanceStatus.Completed
        });
        
        // Add to remittance IDs list
        remittanceIds.push(remittanceId);
        
        emit RemittanceInitiated(remittanceId, sender, recipient, usdAmount, destinationCountry);
        emit RemittanceCompleted(remittanceId, finalEurAmount);
        
        return (remittanceId, finalEurAmount);
    }
    
    /**
     * @dev Get gas metrics for a specific remittance
     * @param id The remittance ID
     */
    function getGasMetrics(bytes32 id) external view returns (GasMetrics memory) {
        return gasMetrics[id];
    }
    
    /**
     * @dev Get remittance details
     * @param id The remittance ID
     */
    function getRemittance(bytes32 id) external view returns (RemittanceRecord memory) {
        return remittances[id];
    }
    
    /**
     * @dev Get total number of remittances processed
     */
    function getRemittanceCount() external view returns (uint256) {
        return remittanceIds.length;
    }
    
    /**
     * @dev Calculate how much EUR would be received for a given USD amount
     */
    function calculateRemittanceEstimate(uint256 usdAmount) external view returns (
        uint256 usdcAfterFee,
        uint256 eurcAfterSwap,
        uint256 eurFinal
    ) {
        // Step 1: Apply buy fee
        usdcAfterFee = usdAmount - (usdAmount * buyFeeBps / 10000);
        
        // Step 2: Apply exchange rate and swap fee
        uint256 rawEurcAmount = (usdcAfterFee * usdToEurRate) / 1000000;
        eurcAfterSwap = rawEurcAmount - (rawEurcAmount * swapFeeBps / 10000);
        
        // Step 3: Apply sell fee
        eurFinal = eurcAfterSwap - (eurcAfterSwap * sellFeeBps / 10000);
        
        return (usdcAfterFee, eurcAfterSwap, eurFinal);
    }
} 