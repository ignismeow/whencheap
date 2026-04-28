import { IsEthereumAddress, IsNotEmpty, IsString, Matches } from 'class-validator';

export class RegisterWalletDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^0x[0-9a-fA-F]{64}$/)
  privateKey!: string;

  @IsEthereumAddress()
  userAddress!: string;
}
