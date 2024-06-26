import * as dotenv from 'dotenv';

dotenv.config();

export const BaseConfig = {
  accessKeyId: process.env.ACCESS_KEY_ID,
  secretAccessKey: process.env.SECRET_ACCESS_KEY,
  region: process.env.REGION,
  accountId: process.env.ACCOUNT_ID,
  dbUsername: process.env.DB_USERNAME,
  dbPassword: process.env.DB_PASSWORD,
  dbName: process.env.DB_NAME,
  dbPort: process.env.DB_PORT,
  mailtrapUrl: process.env.MAILTRAP_URL,
  mailtrapToken: process.env.MAILTRAP_TOKEN,
  mailtrapAccountId: process.env.MAILTRAP_ACCOUNT_ID,
  mailtrapInboxId: process.env.MAILTRAP_INBOX_ID,
  mailtrapEmail: process.env.MAILTRAP_EMAIL,
};
