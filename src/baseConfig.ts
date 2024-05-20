import * as dotenv from 'dotenv';

dotenv.config();

export const BaseConfig = {
  accessKeyId: process.env.ACCESS_KEY_ID,
  secretAccessKey: process.env.SECRET_ACCESS_KEY,
  region: process.env.REGION,
  accountId: process.env.ACCOUNT_ID,
};
