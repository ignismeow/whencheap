import { IsEthereumAddress, IsNotEmpty, IsString, Matches } from 'class-validator';

export class ManagedSessionDto {
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
}
