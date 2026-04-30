import { IsEthereumAddress, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateIntentDto {
  @IsEthereumAddress()
  wallet!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  input!: string;

  @IsOptional()
  @IsObject()
  parsed?: Record<string, unknown>;
}
