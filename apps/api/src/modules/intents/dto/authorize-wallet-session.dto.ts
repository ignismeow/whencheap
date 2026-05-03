import { IsEthereumAddress, IsIn, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class AuthorizeWalletSessionDto {
  @IsEthereumAddress()
  userAddress!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+(\.\d+)?$/)
  maxFeePerTxEth!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+(\.\d+)?$/)
  maxTotalSpendEth!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+$/)
  expiryHours!: string;

  @IsOptional()
  @IsString()
  @IsIn(['sepolia', 'mainnet', 'ethereum', 'eth'])
  chain?: string;
}
