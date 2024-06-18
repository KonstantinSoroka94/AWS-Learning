/* eslint-disable import/no-extraneous-dependencies */
import { describe, expect, test } from '@jest/globals';
import {
  EC2Client,
  DescribeInstancesCommand,
  type DescribeInstancesCommandOutput,
  type DescribeInstancesCommandInput,
} from '@aws-sdk/client-ec2';
import {
  GetBucketEncryptionCommand,
  GetBucketPolicyStatusCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  ListBucketsCommand,
  type ListBucketsCommandOutput,
  ListObjectsCommand,
  type ListObjectsCommandOutput,
  S3Client,
  DeleteObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  type Tag,
} from '@aws-sdk/client-s3';
import axios, { type AxiosResponse } from 'axios';
import { createWriteStream, readFileSync, promises as fsPromises } from 'fs';
import { Client } from 'ssh2';
import { join } from 'path';
import { pipeline } from 'stream';
import _ from 'lodash';
import fs from 'fs-extra';
import FormData from 'form-data';
import { promisify } from 'util';
import { BaseConfig } from '../baseConfig';

const { region } = BaseConfig;

describe('S3', () => {
  const ec2Client: EC2Client = new EC2Client({ region });
  const s3Client: S3Client = new S3Client({ region });

  let publicIpAddress: string = null;
  let publicDnsName: string = null;
  let publicInstance: any = null;
  let bucketName: string = null;

  const bucketPrefix: string = 'cloudximage-imagestorebucketf57d958e-tdzypcdvag2h';
  const s3ImagesPath: string = 'images/';

  describe('Deployment validation', () => {
    beforeAll(async () => {
      const params: DescribeInstancesCommandInput = {
        Filters: [
          {
            Name: 'instance-state-name',
            Values: ['running'],
          },
        ],
      };

      const data: DescribeInstancesCommandOutput = await ec2Client.send(new DescribeInstancesCommand(params));

      const deployedInstances: any[] = data.Reservations.reduce((acc, reservation) => {
        return acc.concat(
          reservation.Instances.map((instance) => ({
            id: instance.InstanceId,
            type: instance.PublicIpAddress ? 'public' : 'private',
            instanceType: instance.InstanceType,
            tags: instance.Tags,
            rootBlockDeviceSize: instance.BlockDeviceMappings[0]?.Ebs,
            os: instance,
          })),
        );
      }, []);

      publicInstance = deployedInstances.find((instance) => instance.type === 'public');

      ({ PublicIpAddress: publicIpAddress, PublicDnsName: publicDnsName } = publicInstance.os);
    });

    test('the application should be deployed in the public subnet and should be accessible by HTTP', async () => {
      // should be accessible via public IP address
      const responsePublicIpAddress: AxiosResponse = await axios.get(`http://${publicIpAddress}/api/image`);
      expect(responsePublicIpAddress.status).toBe(200);

      // should be accessible via public DNS Name
      const responsePublicDnsName: AxiosResponse = await axios.get(`http://${publicDnsName}/api/image`);
      expect(responsePublicDnsName.status).toBe(200);
    });

    test('the application instance should be accessible by SSH protocol', async () => {
      const privateKeyPath: string = join(process.cwd(), 'src', 'credentials', 'cloudximage-eu-central-1.pem');
      const privateKey: string = readFileSync(privateKeyPath, 'utf8');

      const configuration: { [key: string]: string | number } = {
        host: publicIpAddress,
        port: 22,
        username: 'ec2-user',
        privateKey,
      };

      const client: Client = new Client();

      async function connectClient(conn: any, config: any) {
        return new Promise((resolve, reject) => {
          conn
            .on('ready', () => {
              resolve(conn);
            })
            .on('error', (error: Error) => {
              reject(error);
            })
            .connect(config);
        });
      }

      async function execCommand(conn: any, command: any) {
        return new Promise((resolve, reject) => {
          conn.exec(command, (error: Error, stream: any) => {
            if (error) reject(error);

            stream.on('data', (data: any) => {
              resolve(data.toString());
            });
          });
        });
      }

      try {
        const connectedClient = await connectClient(client, configuration);
        const commandOutput = await execCommand(connectedClient, 'whoami');
        client.end();
        expect(connectedClient).toBeInstanceOf(Client);
        expect(commandOutput).toContain('ec2-user');
      } catch (error) {
        client.end();

        if (error instanceof Error) {
          throw new Error(`Error in SSH connection: ${error.message}`);
        }
      }
    });

    test('the application should have access to the S3 bucket via an IAM role', async () => {
      const listBucketsCommand: ListBucketsCommand = new ListBucketsCommand({});
      const listBucketsData: ListBucketsCommandOutput = await s3Client.send(listBucketsCommand);
      bucketName = listBucketsData.Buckets.find((bucket) => bucket.Name.startsWith(bucketPrefix))?.Name;

      if (!bucketName) throw new Error(`No S3 bucket found with prefix: ${bucketPrefix}`);

      try {
        const response: ListObjectsCommandOutput = await s3Client.send(new ListObjectsCommand({ Bucket: bucketName }));
        expect(response.Name).toContain(bucketPrefix);
      } catch (error) {
        if (error instanceof Error) throw new Error(`Error in SSH connection: ${error.message}`);
      }
    });

    test('should return S3 bucket data', async () => {
      const listBucketsCommand: ListBucketsCommand = new ListBucketsCommand({});
      const listBucketsData: ListBucketsCommandOutput = await s3Client.send(listBucketsCommand);
      bucketName = listBucketsData.Buckets.find((bucket) => bucket.Name.startsWith(bucketPrefix))?.Name;

      if (!bucketName) throw new Error(`No S3 bucket found with prefix: ${bucketPrefix}`);

      // Check bucket tags
      const getBucketTaggingCommand: GetBucketTaggingCommand = new GetBucketTaggingCommand({ Bucket: bucketName });
      const { TagSet } = await s3Client.send(getBucketTaggingCommand);
      expect(TagSet.some((tag: Tag) => tag.Key === 'cloudx')).toBe(true);

      // Check bucket encryption
      const getBucketEncryptionCommand: GetBucketEncryptionCommand = new GetBucketEncryptionCommand({
        Bucket: bucketName,
      });
      const { ServerSideEncryptionConfiguration } = await s3Client.send(getBucketEncryptionCommand);
      expect(ServerSideEncryptionConfiguration.Rules?.[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm).toBe(
        'AES256',
      );

      // Check bucket versioning
      const getBucketVersioningCommand: GetBucketVersioningCommand = new GetBucketVersioningCommand({
        Bucket: bucketName,
      });
      const { Status } = await s3Client.send(getBucketVersioningCommand);
      expect(Status === undefined || Status === 'Suspended').toBe(true);

      // Check bucket public access
      const getPublicAccessBlockCommand: GetPublicAccessBlockCommand = new GetPublicAccessBlockCommand({
        Bucket: bucketName,
      });
      const getBucketPolicyStatusCommand: GetBucketPolicyStatusCommand = new GetBucketPolicyStatusCommand({
        Bucket: bucketName,
      });

      const { PublicAccessBlockConfiguration } = await s3Client.send(getPublicAccessBlockCommand);
      const { PolicyStatus } = await s3Client.send(getBucketPolicyStatusCommand);

      const hasPublicAccess: boolean =
        PublicAccessBlockConfiguration.BlockPublicAcls &&
        PublicAccessBlockConfiguration.IgnorePublicAcls &&
        PublicAccessBlockConfiguration.BlockPublicPolicy &&
        PublicAccessBlockConfiguration.RestrictPublicBuckets &&
        PolicyStatus.IsPublic === false;

      expect(hasPublicAccess).toBe(true);
    });
  });

  describe('Application functional validation', () => {
    beforeAll(async () => {
      const params: DescribeInstancesCommandInput = {
        Filters: [
          {
            Name: 'instance-state-name',
            Values: ['running'],
          },
        ],
      };
      const data: DescribeInstancesCommandOutput = await ec2Client.send(new DescribeInstancesCommand(params));
      const deployedInstances: any[] = data.Reservations.reduce((acc, reservation) => {
        return acc.concat(
          reservation.Instances.map((instance) => ({
            id: instance.InstanceId,
            type: instance.PublicIpAddress ? 'public' : 'private',
            os: instance,
          })),
        );
      }, []);
      publicInstance = deployedInstances.find((instance) => instance.type === 'public');
      const listBucketsCommand: ListBucketsCommand = new ListBucketsCommand({});
      const listBucketsData: ListBucketsCommandOutput = await s3Client.send(listBucketsCommand);
      bucketName = listBucketsData.Buckets.find((bucket) => bucket.Name.startsWith(bucketPrefix))?.Name;
      if (!bucketName) throw new Error(`No S3 bucket found with prefix: ${bucketPrefix}`);
    });

    test('should upload images to the S3 bucket (via application API)', async () => {
      publicIpAddress = publicInstance.os.PublicIpAddress;
      const image: string = _.sample(['fire.jpg', 'lemon.jpg', 'workspace.jpg']);
      const filePath: string = join(process.cwd(), 'src', 'fixtures', image);
      const formData: FormData = new FormData();
      formData.append('upfile', fs.createReadStream(filePath));
      const headers: { [key: string]: string } = {
        'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`,
        ...formData.getHeaders(),
      };
      const response: AxiosResponse = await axios.post(`http://${publicIpAddress}/api/image`, formData, { headers });
      expect(response.status).toBe(200);
      expect(typeof response.data.id).toBe('number');
    });

    test('should download images from the S3 bucket', async () => {
      try {
        const folderPath: string = join(process.cwd(), 'downloads');
        await fs.ensureDir(folderPath);
      } catch (error) {
        if (error instanceof Error) throw new Error(`Error creating folder: ${error.message}`);
        throw error;
      }
      const destinationPath: string = join(process.cwd(), 'downloads', 'image.jpg');
      const listObjectsCommand: ListObjectsV2Command = new ListObjectsV2Command({ Bucket: bucketName });
      const { Contents } = await s3Client.send(listObjectsCommand);
      if (!Contents.length) throw new Error(`No images uploaded to S3`);
      const writeStream = createWriteStream(destinationPath);
      const asyncPipeline = promisify(pipeline);
      await asyncPipeline(JSON.stringify(Contents), writeStream);
      const fileExists = await fsPromises
        .access(destinationPath)
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(true);
      const fileStats = await fsPromises.stat(destinationPath);
      expect(fileStats.size).toBeGreaterThan(0);
    });

    test('should view a list of uploaded images', async () => {
      publicIpAddress = publicInstance.os.PublicIpAddress;
      const listObjectsCommand: ListObjectsV2Command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: s3ImagesPath,
      });
      const listObjectsCommandResponse: ListObjectsV2CommandOutput = await s3Client.send(listObjectsCommand);
      const imagesListFromS3: string[] = listObjectsCommandResponse.Contents.map((item) => item.Key);
      expect(imagesListFromS3.length).toBeGreaterThan(0);
      const response: AxiosResponse = await axios.get(`http://${publicIpAddress}/api/image`);
      expect(response.status).toBe(200);
      const imagesListFromApi: string[] = response.data.map((image) => image.object_key);
      expect(imagesListFromApi.length).toBeGreaterThan(0);
    });

    test('should delete an image from the S3 bucket', async () => {
      const listObjectsCommand: ListObjectsV2Command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: s3ImagesPath,
      });
      const listObjectsCommandBeforeDeletionResponse: ListObjectsV2CommandOutput =
        await s3Client.send(listObjectsCommand);
      const imageListBeforeDeletion: string[] = listObjectsCommandBeforeDeletionResponse.Contents.map(
        (item) => item.Key,
      );
      expect(imageListBeforeDeletion.length).toBeGreaterThan(0);
      const imageKeyToDelete: string = _.sample(imageListBeforeDeletion);
      const deleteObjectCommand: DeleteObjectCommand = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: imageKeyToDelete,
      });
      await s3Client.send(deleteObjectCommand);
      const listObjectsCommandAfterDeletionResponse: ListObjectsV2CommandOutput =
        await s3Client.send(listObjectsCommand);
      const imageListAfterDeletion: string[] = listObjectsCommandAfterDeletionResponse.Contents.map((item) => item.Key);
      expect(imageListAfterDeletion).not.toContain(imageKeyToDelete);
    });
  });
});
