/* eslint-disable import/no-extraneous-dependencies */
import { describe, expect, test } from '@jest/globals';
import {
  DeleteObjectCommand,
  ListBucketsCommand,
  type ListBucketsCommandOutput,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  S3Client,
} from '@aws-sdk/client-s3';
import AWS from 'aws-sdk';
import internal from 'stream';
import {
  DescribeInstancesCommand,
  type DescribeInstancesCommandOutput,
  EC2Client,
  type DescribeInstancesCommandInput,
} from '@aws-sdk/client-ec2';
import {
  EventSourceMappingConfiguration,
  FunctionConfiguration,
  GetFunctionConfigurationCommand,
  GetFunctionConfigurationCommandOutput,
  LambdaClient,
  ListEventSourceMappingsCommand,
  ListFunctionsCommand,
  ListFunctionsCommandOutput,
  ListTagsCommand,
  ListTagsCommandOutput,
} from '@aws-sdk/client-lambda';
import axios, { type AxiosResponse } from 'axios';
import _ from 'lodash';
import fs, { createReadStream } from 'fs-extra';
import { join } from 'path';
import FormData from 'form-data';
import {
  type AttributeValue,
  DynamoDBClient,
  ListTablesCommand,
  type ListTablesCommandOutput,
  ScanCommand,
  type ScanCommandOutput,
  DescribeTableCommandOutput,
  DescribeTableCommand,
  DescribeTimeToLiveCommandOutput,
  DescribeTimeToLiveCommand,
  ListTagsOfResourceCommandOutput,
  ListTagsOfResourceCommand,
} from '@aws-sdk/client-dynamodb';
import { IAMClient, ListRolesCommand, ListRolesCommandOutput, Role } from '@aws-sdk/client-iam';
import {
  ConfirmSubscriptionCommand,
  ListSubscriptionsByTopicCommand,
  ListSubscriptionsByTopicCommandOutput,
  ListSubscriptionsCommand,
  ListSubscriptionsCommandOutput,
  ListTopicsCommand,
  ListTopicsCommandOutput,
  SNSClient,
  SubscribeCommand,
  SubscribeCommandInput,
  SubscribeCommandOutput,
  Subscription,
} from '@aws-sdk/client-sns';
import {
  ListQueuesCommand,
  ListQueuesCommandOutput,
  SQSClient,
  SendMessageCommand,
  SendMessageCommandInput,
  SendMessageCommandOutput,
} from '@aws-sdk/client-sqs';
import { BaseConfig } from '../baseConfig';
import { generateMailtrapEmail } from '../commands/Common';
import { MailtrapApiClient } from '../commands/MailtrapApiClient';

describe('Serverless', () => {
  const { region } = BaseConfig;

  const ec2Client: EC2Client = new EC2Client({ region });
  const dynamoDBClient = new DynamoDBClient({ region });
  const iamClient: IAMClient = new IAMClient({ region });
  const sqsClient: SQSClient = new SQSClient({ region });
  const snsClient: SNSClient = new SNSClient({ region });
  const lambdaClient = new LambdaClient({ region });
  const s3Client: S3Client = new S3Client(region);

  const dynamoDBTablePrefix = 'cloudxserverless-DatabaseImagesTable';
  const topicSnsPrefix = 'cloudxserverless-TopicSNSTopic';
  const queueSqsPrefix = 'cloudxserverless-QueueSQSQueue';
  const lambdaFunctionPrefix = 'cloudxserverless-EventHandlerLambda';
  const bucketPrefix: string = 'cloudxserverless-imagestorebucket';
  const s3ImagesPath: string = 'fixtures/';

  const mailtrapEmailEndpoint: string = generateMailtrapEmail();

  let ec2IpAddress: string = null;
  let dynamoDBTableName: string = null;
  let randomImageId: string = null;
  let topicSns: string = null;
  let queueSqsUrl: string = null;
  let lambdaFunctionName: string = null;
  let bucketName: string = null;

  describe('DynamoDB regression testing', () => {
    beforeAll(async function () {
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

      const ec2Instance: any = deployedInstances.find((instance) => instance.type === 'public');
      ({ PublicIpAddress: ec2IpAddress } = ec2Instance.os);

      if (!ec2Instance) throw new Error(`No public EC2 instance found`);

      const listTablesResp: ListTablesCommandOutput = await dynamoDBClient.send(new ListTablesCommand({}));

      dynamoDBTableName = listTablesResp.TableNames.find((table) => table.includes(dynamoDBTablePrefix));

      if (!dynamoDBTableName) throw new Error('There is no DynamoDB table');
    });

    test('the uploaded image metadata should be stored in DynamoDB table', async () => {
      const randomImage: string = _.sample(['fire.jpg', 'lemon.jpg', 'workspace.jpg']);
      const filePath: string = join(process.cwd(), 'src', 'fixtures', randomImage);

      const formData: FormData = new FormData();
      formData.append('upfile', fs.createReadStream(filePath));

      const headers: { [key: string]: string } = {
        'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`,
        ...formData.getHeaders(),
      };

      const response: AxiosResponse = await axios.post(`http://${ec2IpAddress}/api/image`, formData, { headers });
      expect(response.status).toBe(200);
      expect(typeof response.data.id).toBe('string');

      const createdImageId = response.data.id;

      const scanResp: ScanCommandOutput = await dynamoDBClient.send(new ScanCommand({ TableName: dynamoDBTableName }));
      const imageIds: string[] = scanResp.Items.map((image: Record<string, AttributeValue>) => image.id.S);

      expect(imageIds).toContain(createdImageId);

      randomImageId = _.sample(imageIds);
    });

    test('the image metadata should be returned by {base URL}/image/{image_id} GET request', async () => {
      const response: AxiosResponse = await axios.get(`http://${ec2IpAddress}/api/image/${randomImageId}`);
      expect(response.status).toBe(200);

      expect(typeof response.data.id).toBe('string');
      expect(typeof response.data.object_key).toBe('string');
      expect(typeof response.data.object_type).toBe('string');
      expect(typeof response.data.object_size).toBe('number');
      expect(typeof response.data.created_at).toBe('number');
      expect(typeof response.data.last_modified).toBe('number');
    });

    test('the image metadata for the deleted image should be deleted from the database', async () => {
      const deleteImageResp: AxiosResponse = await axios.delete(`http://${ec2IpAddress}/api/image/${randomImageId}`);
      expect(deleteImageResp.status).toBe(200);

      const getImagesResp: AxiosResponse = await axios.get(`http://${ec2IpAddress}/api/image`);
      expect(getImagesResp.status).toBe(200);

      const imagesLengthFromAPI: number = getImagesResp.data.length;

      const scanResp: ScanCommandOutput = await dynamoDBClient.send(new ScanCommand({ TableName: dynamoDBTableName }));
      const imageIds = scanResp.Items.map((image: Record<string, AttributeValue>) => image.id.S);

      const imagesLengthFromDB: number = scanResp.Items.length;

      expect(imagesLengthFromAPI).toBe(imagesLengthFromDB);
      expect(imageIds).not.toContain(randomImageId);
    });
  });

  describe('Application functional validation', function () {
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

      const ec2Instance: any = deployedInstances.find((instance) => instance.type === 'public');

      if (!ec2Instance) throw new Error(`No public EC2 instance found`);

      ({ PublicIpAddress: ec2IpAddress } = ec2Instance.os);

      const listTablesResp: ListTablesCommandOutput = await dynamoDBClient.send(new ListTablesCommand({}));

      dynamoDBTableName = listTablesResp.TableNames.find((table) => table.includes(dynamoDBTablePrefix));

      if (!dynamoDBTableName) throw new Error('There is no DynamoDB table');

      const listTopicsResp: ListTopicsCommandOutput = await snsClient.send(new ListTopicsCommand({}));

      ({ TopicArn: topicSns } = listTopicsResp.Topics.find((topic) => topic.TopicArn.includes(topicSnsPrefix)));

      if (!topicSns) throw new Error('There is no Topics ARN for the SNS');

      const listQueuesResp: ListQueuesCommandOutput = await sqsClient.send(new ListQueuesCommand({}));

      queueSqsUrl = listQueuesResp.QueueUrls.find((queue) => queue.includes(queueSqsPrefix));

      if (!queueSqsUrl) throw new Error('There is no Queue URL for the SQS');

      const listFunctionsResp: ListFunctionsCommandOutput = await lambdaClient.send(new ListFunctionsCommand({}));

      lambdaFunctionName = listFunctionsResp.Functions.find((lambda: FunctionConfiguration) => {
        return lambda.FunctionName.includes(lambdaFunctionPrefix);
      }).FunctionName;

      if (!lambdaFunctionName) throw new Error('There is no Lambda function');
    });

    it('the application database should be replaced with a DynamoDB table', async () => {
      const describeTableResp: DescribeTableCommandOutput = await dynamoDBClient.send(
        new DescribeTableCommand({ TableName: dynamoDBTableName }),
      );
      expect(describeTableResp.Table.TableArn).toContain(dynamoDBTablePrefix);
      expect(describeTableResp.Table.TableId).toBeDefined();
      expect(describeTableResp.Table.TableName).toContain(dynamoDBTablePrefix);
      expect(describeTableResp.Table.TableStatus).toBe('ACTIVE');
    });

    it('the DynamoDB table should store the image metadata information', async () => {
      const randomImage: string = _.sample(['fire.jpg', 'lemon.jpg', 'workspcae.jpg']);
      const filePath: string = join(process.cwd(), 'src', 'fixtures', randomImage);

      const formData: FormData = new FormData();
      formData.append('upfile', createReadStream(filePath));

      const headers: { [key: string]: string } = {
        'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`,
        ...formData.getHeaders(),
      };

      const response: AxiosResponse = await axios.post(`http://${ec2IpAddress}/api/image`, formData, { headers });
      expect(response.status).toBe(200);
      expect(typeof response.data.id).toBe('string');

      const scanResp: ScanCommandOutput = await dynamoDBClient.send(
        new ScanCommand({
          TableName: dynamoDBTableName,
          Limit: 1,
        }),
      );

      expect(Object.keys(scanResp.Items[0])).toEqual([
        'object_key',
        'object_size',
        'created_at',
        'object_type',
        'id',
        'last_modified',
      ]);
    });

    it('should subscribe a user', async () => {
      const subscribeParams: SubscribeCommandInput = {
        Protocol: 'email',
        TopicArn: topicSns,
        Endpoint: mailtrapEmailEndpoint,
      };

      // Subscribe
      const subscribeResp: SubscribeCommandOutput = await snsClient.send(new SubscribeCommand(subscribeParams));
      expect(typeof subscribeResp.SubscriptionArn).toBe('string');

      // Get email
      const subject = 'AWS Notification - Subscription Confirmation';
      const mailtrapService: MailtrapApiClient = new MailtrapApiClient();
      const subscriptionResp: AxiosResponse<string, any> = await mailtrapService.getLatestMessageHTMLBySubject(
        mailtrapEmailEndpoint,
        subject,
      );

      // Extract URL
      const urlRegex: RegExp = /(https:\/\/sns\.us-east-1\.amazonaws\.com[^"]*)/;
      const [, url] = subscriptionResp.data.match(urlRegex);

      // Extract token
      const tokenRegex: RegExp = /Token=([^&]*)/;
      const [, token] = url.match(tokenRegex);

      // Confirm subscription
      await snsClient.send(
        new ConfirmSubscriptionCommand({
          TopicArn: topicSns,
          Token: token,
        }),
      );

      // Get subscription
      const listSubscriptionsResp: ListSubscriptionsByTopicCommandOutput = await snsClient.send(
        new ListSubscriptionsByTopicCommand({
          TopicArn: topicSns,
        }),
      );

      const subscription: Subscription = listSubscriptionsResp.Subscriptions.find(
        ({ Endpoint }) => Endpoint === mailtrapEmailEndpoint,
      );

      expect(subscription.SubscriptionArn).toContain('cloudxserverless-TopicSNSTopic');
      expect(subscription.Protocol).toBe('email');
      expect(subscription.Endpoint).toBe(mailtrapEmailEndpoint);
      expect(subscription.TopicArn).toBe(topicSns);
    });

    it('the subscribed user receives notifications about images events', async () => {
      const randomImage: string = _.sample(['fire.jpg', 'lemon.jpg', 'workspace.jpg']);
      const filePath: string = join(process.cwd(), 'src', 'fixtures', randomImage);

      const formData: FormData = new FormData();
      formData.append('upfile', createReadStream(filePath));

      const headers: { [key: string]: string } = {
        'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`,
        ...formData.getHeaders(),
      };

      const response: AxiosResponse = await axios.post(`http://${ec2IpAddress}/api/image`, formData, { headers });
      expect(response.status).toBe(200);
      expect(typeof response.data.id).toBe('string');

      // Get email
      const subject = 'AWS Notification Message';
      const mailtrapService: MailtrapApiClient = new MailtrapApiClient();
      const notificationResp: AxiosResponse<string, any> = await mailtrapService.getLatestMessageTextBySubject(
        mailtrapEmailEndpoint,
        subject,
      );
      const emailText: string = notificationResp.data;

      expect(emailText).toContain('event_type: upload');
      expect(emailText).toContain('object_key: images/');
      expect(emailText).toContain('object_type: binary/octet-stream');
      expect(emailText).toContain('last_modified: ');
      expect(emailText).toContain('object_size: ');
      expect(emailText).toContain('download_link: http://ec2');
    });

    it('should return a list of all subscriptions', async () => {
      const listSubscriptionsResp: ListSubscriptionsCommandOutput = await snsClient.send(
        new ListSubscriptionsCommand({}),
      );
      expect(typeof listSubscriptionsResp.Subscriptions).toBe('array');
      expect(listSubscriptionsResp.Subscriptions.length).toBeGreaterThan(0);
    });

    it('should be able to send a message to an SQS queue', async () => {
      const params: SendMessageCommandInput = {
        QueueUrl: queueSqsUrl,
        MessageBody: 'Event message',
      };

      const data: SendMessageCommandOutput = await sqsClient.send(new SendMessageCommand(params));
      expect(data).toHaveProperty('MD5OfMessageBody');
      expect(data).toHaveProperty('MessageId');
    });

    it('lambda function should be subscribed to the SQS queue to filter and put event messages to the SNS topic', async () => {
      const listEventSourceMappingsResp = await lambdaClient.send(
        new ListEventSourceMappingsCommand({
          FunctionName: lambdaFunctionName,
        }),
      );

      const sqsQueueLambda: EventSourceMappingConfiguration = listEventSourceMappingsResp.EventSourceMappings.find(
        (mapping: EventSourceMappingConfiguration) => {
          return mapping.FunctionArn.includes(lambdaFunctionPrefix);
        },
      );

      expect(sqsQueueLambda.EventSourceArn).toContain('cloudxserverless-QueueSQSQueue');
      expect(sqsQueueLambda.State).toBe('Enabled');
      expect(sqsQueueLambda.StateTransitionReason).toBe('USER_INITIATED');
      expect(sqsQueueLambda.UUID).toBeDefined();
    });

    it('the application should have access to the S3 bucket, the DynamoDB table, the SQS queue and the SNS topic instance via IAM roles', async () => {
      const listRolesResp: ListRolesCommandOutput = await iamClient.send(new ListRolesCommand({}));

      const roles: string[] = listRolesResp.Roles.map((role: Role) => role.RoleName);

      const isRoleExist = (roleName: string) => roles.some((role) => role.includes(roleName));

      expect(isRoleExist('AWSServiceRoleForApplicationAutoScaling_DynamoDBTable')).toBe(true);
      expect(isRoleExist('AWSServiceRoleForRDS')).toBe(true);
      expect(isRoleExist('cloudxserverless-AppInstanceInstanceRole')).toBe(true);
      expect(isRoleExist('cloudxserverless-CustomCDKBucketDeployment')).toBe(true);
      expect(isRoleExist('cloudxserverless-CustomS3AutoDeleteObjectsCustom')).toBe(true);
      expect(isRoleExist('cloudxserverless-EventHandlerLambdaRole')).toBe(true);
      expect(isRoleExist('cloudxserverless-LogRetention')).toBe(true);
    });

    it('should return Lambda configuration', async () => {
      const getFunctionConfigurationData: GetFunctionConfigurationCommandOutput = await lambdaClient.send(
        new GetFunctionConfigurationCommand({
          FunctionName: lambdaFunctionName,
        }),
      );

      expect(getFunctionConfigurationData.MemorySize).toBe(128);
      expect(getFunctionConfigurationData.Timeout).toBe(3);
      expect(getFunctionConfigurationData.EphemeralStorage.Size).toBe(512);
      expect(getFunctionConfigurationData.Environment.Variables.TOPIC_ARN).toContain('cloudxserverless-TopicSNSTopic');
      expect(getFunctionConfigurationData.LoggingConfig.LogFormat).toBe('Text');
      expect(getFunctionConfigurationData.LoggingConfig.LogGroup).toContain(
        '/aws/lambda/cloudxserverless-EventHandlerLambda',
      );

      const lambdaFunctionArn: string = getFunctionConfigurationData.FunctionArn;

      const listTagsResp: ListTagsCommandOutput = await lambdaClient.send(
        new ListTagsCommand({
          Resource: lambdaFunctionArn,
        }),
      );

      expect(listTagsResp?.Tags?.cloudx).toBe('qa');
    });

    it('should return DynamoDB table', async () => {
      const describeTableResp: DescribeTableCommandOutput = await dynamoDBClient.send(
        new DescribeTableCommand({ TableName: dynamoDBTableName }),
      );

      expect(describeTableResp.Table.ProvisionedThroughput.ReadCapacityUnits).toBe(5);
      expect(describeTableResp.Table.ProvisionedThroughput.WriteCapacityUnits).toBe(1);
      expect(describeTableResp?.Table?.GlobalSecondaryIndexes).toBeUndefined();

      const describeTimeToLiveResp: DescribeTimeToLiveCommandOutput = await dynamoDBClient.send(
        new DescribeTimeToLiveCommand({ TableName: dynamoDBTableName }),
      );

      expect(describeTimeToLiveResp.TimeToLiveDescription.TimeToLiveStatus).toBe('DISABLED');

      const resourceArn: string = describeTableResp.Table.TableArn;

      const listTagsOfResourceResp: ListTagsOfResourceCommandOutput = await dynamoDBClient.send(
        new ListTagsOfResourceCommand({ ResourceArn: resourceArn }),
      );

      expect(listTagsOfResourceResp.Tags.find((tag) => tag.Key === 'cloudx').Value).toBe('qa');
    });
  });

  describe('Serverless S3 regression testing', () => {
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

      const ec2Instance = deployedInstances.find((instance) => instance.type === 'public');
      ({ PublicIpAddress: ec2IpAddress } = ec2Instance.os);

      if (!ec2IpAddress) throw new Error(`No public EC2 instance found`);

      const listBucketsCommand: ListBucketsCommand = new ListBucketsCommand({});
      const listBucketsData: ListBucketsCommandOutput = await s3Client.send(listBucketsCommand);
      bucketName = listBucketsData.Buckets.find((bucket) => bucket.Name.startsWith(bucketPrefix))?.Name;

      if (!bucketName) throw new Error(`No S3 bucket found with prefix: ${bucketPrefix}`);
    });

    it('should upload images to the S3 bucket (via application API)', async () => {
      const image: string = _.sample(['fire.jpg', 'lemon.jpg', 'workspace.jpg']);
      const filePath: string = join(process.cwd(), 'src', 'fixtures', image);

      const formData: FormData = new FormData();
      formData.append('upfile', fs.createReadStream(filePath));

      const headers: { [key: string]: string } = {
        'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`,
        ...formData.getHeaders(),
      };

      const response: AxiosResponse = await axios.post(`http://${ec2IpAddress}/api/image`, formData, { headers });
      expect(response.status).toBe(200);
      expect(typeof response.data.id).toBe('string');
    });

    it('should download images from the S3 bucket', async () => {
      try {
        const folderPath: string = join(process.cwd(), 'downloads');
        await fs.ensureDir(folderPath);
      } catch (error) {
        throw new Error(`${JSON.stringify(error)}`);
      }

      const destinationPath: string = join(process.cwd(), 'downloads', 'image.jpg');

      const listObjectsCommand: ListObjectsV2Command = new ListObjectsV2Command({ Bucket: bucketName });
      const { Contents } = await s3Client.send(listObjectsCommand);

      if (!Contents.length) throw new Error(`No images uploaded to S3`);

      const imageKey: string = _.sample(Contents.map(({ Key }) => Key));

      const s3: AWS.S3 = new AWS.S3({ region });

      try {
        const getObjectCommandResponse: internal.Readable = s3
          .getObject({ Bucket: bucketName, Key: imageKey })
          .createReadStream();

        const fileStream: fs.WriteStream = fs.createWriteStream(destinationPath);
        getObjectCommandResponse.pipe(fileStream);

        await new Promise((resolve, reject) => {
          fileStream.on('finish', () => {
            resolve(true);
          });

          fileStream.on('error', (error) => {
            reject(error);
          });
        });
      } catch (error) {
        if (error instanceof Error) throw new Error(`${error}`);
      }

      expect(fs.existsSync(destinationPath)).toBe(true);

      fs.unlinkSync(destinationPath);
    });

    it('should view a list of uploaded images', async () => {
      const listObjectsCommand: ListObjectsV2Command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: s3ImagesPath,
      });
      const listObjectsCommandResponse: ListObjectsV2CommandOutput = await s3Client.send(listObjectsCommand);
      const imagesListFromS3: string[] = listObjectsCommandResponse.Contents.map((item) => item.Key);

      expect(imagesListFromS3.length).toBeGreaterThan(0);

      const response: AxiosResponse = await axios.get(`http://${ec2IpAddress}/api/image`);
      expect(response.status).toBe(200);
      const imagesListFromApi: string[] = response.data.map((image) => image.object_key);

      expect(imagesListFromApi.length).toBeGreaterThan(0);
    });

    it('should delete an image from the S3 bucket', async () => {
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
