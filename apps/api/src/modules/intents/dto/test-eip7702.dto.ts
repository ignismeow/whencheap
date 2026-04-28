import { IsEthereumAddress, IsNotEmpty, IsString, Matches } from 'class-validator';

export class TestEip7702Dto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^0x[0-9a-fA-F]{64}$/)
  userPrivateKey!: string;

  @IsEthereumAddress()
  recipient!: string;

  @IsString()
  @IsNotEmpty()
  amount!: string;
}
