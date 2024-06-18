/* eslint-disable import/no-extraneous-dependencies */
import {
  DescribeInstancesCommand,
  type DescribeInstancesCommandInput,
  type DescribeInstancesCommandOutput,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { GetInstanceProfileCommandOutput, GetInstanceProfileCommand, IAMClient } from '@aws-sdk/client-iam';
import axios, { AxiosResponse } from 'axios';
import { describe, expect, test } from '@jest/globals';
import {
  ConfirmSubscriptionCommand,
  ListTopicsCommand,
  type ListTopicsCommandOutput,
  SNSClient,
  type ListSubscriptionsByTopicCommandOutput,
  ListSubscriptionsByTopicCommand,
  type Subscription,
  type ConfirmSubscriptionCommandOutput,
  SubscribeCommandInput,
  GetSubscriptionAttributesCommand,
  GetTopicAttributesCommand,
  GetTopicAttributesCommandOutput,
  ListSubscriptionsCommand,
  ListSubscriptionsCommandOutput,
  ListTagsForResourceCommand,
  ListTagsForResourceCommandOutput,
  PublishCommand,
  PublishCommandInput,
  PublishCommandOutput,
  SubscribeCommand,
  SubscribeCommandOutput,
  UnsubscribeCommand,
} from '@aws-sdk/client-sns';
import {
  ListQueuesCommand,
  type ListQueuesCommandOutput,
  SQSClient,
  GetQueueAttributesCommand,
  GetQueueAttributesCommandOutput,
  ListQueueTagsCommand,
  ListQueueTagsCommandOutput,
  SendMessageCommand,
  SendMessageCommandInput,
  SendMessageCommandOutput,
} from '@aws-sdk/client-sqs';
import _ from 'lodash';
import { join } from 'path';
import { createReadStream } from 'fs-extra';
import FormData from 'form-data';
import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { BaseConfig } from '../baseConfig';
import { MailtrapApiClient } from '../commands/MailtrapApiClient';
import { generateMailtrapEmail } from '../commands/Common';

describe('SNS/SQS', () => {
  const { region } = BaseConfig;

  const ec2: EC2Client = new EC2Client({ region });

  const snsClient: SNSClient = new SNSClient({ region });

  const sqsClient: SQSClient = new SQSClient({ region });

  const iamClient: IAMClient = new IAMClient({ region });

  const mailtrapEmail: string = generateMailtrapEmail();

  const topicSnsPrefix = 'cloudximage-TopicSNSTopic';
  const queueSqsPrefix = 'cloudximage-QueueSQSQueue';

  let ec2IpAddress: string = null;

  let topicSns: string = null;
  let queueSqsUrl: string = null;

  describe('Deployment validation', function () {
    beforeAll(async () => {
      const listTopicsResp: ListTopicsCommandOutput = await snsClient.send(new ListTopicsCommand({}));

      ({ TopicArn: topicSns } = listTopicsResp.Topics.find((topic) => topic.TopicArn.includes(topicSnsPrefix)));

      if (!topicSns) throw new Error('There is no Topics ARN for the SNS');

      const listQueuesResp: ListQueuesCommandOutput = await sqsClient.send(new ListQueuesCommand({}));

      queueSqsUrl = listQueuesResp.QueueUrls.find((queue) => queue.includes(queueSqsPrefix));

      if (!queueSqsUrl) throw new Error('There is no Queue URL for the SQS');
    });

    it('should subscribe and unsubscribe a user', async () => {
      const endpoint: string = generateMailtrapEmail();

      const subscribeParams: SubscribeCommandInput = {
        Protocol: 'email',
        TopicArn: topicSns,
        Endpoint: endpoint,
      };

      // Subscribe
      const subscribeResp: SubscribeCommandOutput = await snsClient.send(new SubscribeCommand(subscribeParams));
      expect(typeof subscribeResp.SubscriptionArn).toBe('string');

      // Get email
      const subject = 'AWS Notification - Subscription Confirmation';
      const mailtrapService: MailtrapApiClient = new MailtrapApiClient();
      const subscriptionResp: AxiosResponse<string, any> = await mailtrapService.getLatestMessageHTMLBySubject(
        endpoint,
        subject,
      );

      // Extract URL
      const urlRegex: RegExp = /(https:\/\/sns\.us-east-1\.amazonaws\.com[^"]*)/;
      const [, url] = subscriptionResp.data.match(urlRegex);

      // Extract token
      const tokenRegex: RegExp = /Token=([^&]*)/;
      const [, token] = url.match(tokenRegex);

      // Confirm subscription
      const confirmSubscriptionResp: ConfirmSubscriptionCommandOutput = await snsClient.send(
        new ConfirmSubscriptionCommand({
          TopicArn: topicSns,
          Token: token,
        }),
      );

      const { SubscriptionArn } = confirmSubscriptionResp;

      // Get subscription
      const listSubscriptionsResp: ListSubscriptionsByTopicCommandOutput = await snsClient.send(
        new ListSubscriptionsByTopicCommand({
          TopicArn: topicSns,
        }),
      );

      const subscription: Subscription = listSubscriptionsResp.Subscriptions.find(
        ({ Endpoint }) => Endpoint === endpoint,
      );

      expect(subscription.SubscriptionArn).toContain('cloudximage-TopicSNSTopic');
      expect(subscription.Protocol).toBe('email');
      expect(subscription.Endpoint).toBe(endpoint);
      expect(subscription.TopicArn).toBe(topicSns);

      // Unsubscribe
      await snsClient.send(new UnsubscribeCommand({ SubscriptionArn }));

      // Check if it's unsubscribed
      try {
        await snsClient.send(new GetSubscriptionAttributesCommand({ SubscriptionArn }));
        throw new Error('Subscription still exists.');
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`${error}`);
        }
      }
    });

    it('should return a list of all subscriptions', async () => {
      const endpoint = `test+${randomUUID()}@example.com`;

      const params: SubscribeCommandInput = {
        Protocol: 'email',
        TopicArn: topicSns,
        Endpoint: endpoint,
      };

      const subscribeResp: SubscribeCommandOutput = await snsClient.send(new SubscribeCommand(params));
      expect(typeof subscribeResp.SubscriptionArn).toBe('string');

      const listSubscriptionsResp: ListSubscriptionsCommandOutput = await snsClient.send(
        new ListSubscriptionsCommand({}),
      );
      expect(typeof listSubscriptionsResp.Subscriptions).toBe('array');
      expect(listSubscriptionsResp.Subscriptions.map((subscription) => subscription.Endpoint)).toContain(endpoint);
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

    it('should be able to publish a message to an SNS topic', async () => {
      const params: PublishCommandInput = {
        TopicArn: topicSns,
        Message: 'Test Message',
      };

      const data: PublishCommandOutput = await snsClient.send(new PublishCommand(params));
      expect(data).toHaveProperty('MessageId');
    });

    it('should have IAM roles assigned', async () => {
      const describeInstancesResp: DescribeInstancesCommandOutput = await ec2.send(new DescribeInstancesCommand({}));

      const instanceId: string = describeInstancesResp?.Reservations?.[0]?.Instances?.[0]?.InstanceId;

      const instanceResp: DescribeInstancesCommandOutput = await ec2.send(
        new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
      );

      const instanceProfileArn: string = instanceResp.Reservations?.[0].Instances?.[0].IamInstanceProfile?.Arn;
      const [, instanceProfileName] = instanceProfileArn.split('/');

      const instanceProfileData: GetInstanceProfileCommandOutput = await iamClient.send(
        new GetInstanceProfileCommand({ InstanceProfileName: instanceProfileName }),
      );

      const roles: string[] = instanceProfileData.InstanceProfile.Roles.map((role) => role.RoleName);
      expect(Array.isArray(roles)).toBe(true);
    });

    it('should match SNS queue requirements', async () => {
      const attrsResp: GetTopicAttributesCommandOutput = await snsClient.send(
        new GetTopicAttributesCommand({
          TopicArn: topicSns,
        }),
      );

      expect(attrsResp.Attributes?.KmsMasterKeyId).toBeUndefined();

      const tagsResp: ListTagsForResourceCommandOutput = await snsClient.send(
        new ListTagsForResourceCommand({
          ResourceArn: topicSns,
        }),
      );

      expect(tagsResp.Tags.find((tag) => tag.Key === 'cloudx').Value).toBe('qa');
    });

    it('should match SQS queue requirements', async () => {
      const attrsResp: GetQueueAttributesCommandOutput = await sqsClient.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueSqsUrl,
          AttributeNames: ['All'],
        }),
      );

      expect(attrsResp.Attributes?.SqsManagedSseEnabled).toBe('true');

      const tagsResp: ListQueueTagsCommandOutput = await sqsClient.send(
        new ListQueueTagsCommand({
          QueueUrl: queueSqsUrl,
        }),
      );

      expect(tagsResp.Tags.cloudx).toBe('qa');
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

      const data: DescribeInstancesCommandOutput = await ec2.send(new DescribeInstancesCommand(params));

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

      if (!ec2Instance) throw new Error(`No public EC2 instance found`);

      ({ PublicIpAddress: ec2IpAddress } = ec2Instance.os);

      const listTopicsResp: ListTopicsCommandOutput = await snsClient.send(new ListTopicsCommand({}));

      ({ TopicArn: topicSns } = listTopicsResp.Topics.find((topic) => topic.TopicArn.includes(topicSnsPrefix)));

      if (!topicSns) throw new Error('There is no Topics ARN for the SNS');

      const listQueuesResp: ListQueuesCommandOutput = await sqsClient.send(new ListQueuesCommand({}));

      queueSqsUrl = listQueuesResp.QueueUrls.find((queue) => queue.includes(queueSqsPrefix));

      if (!queueSqsUrl) throw new Error('There is no Queue URL for the SQS');
    });

    test('the user can subscribe to notifications about application events via a provided email address', async () => {
      const email = `test+${randomUUID()}@example.com`;

      const response: AxiosResponse = await axios.post(`http://${ec2IpAddress}/api/notification/${email}`);
      expect(response.status).toBe(200);
      expect(response.data).toContain('Successfully subscribed.');
    });

    test('the user has to confirm the subscription after receiving the confirmation email', async () => {
      const postNotificationResp: AxiosResponse = await axios.post(
        `http://${ec2IpAddress}/api/notification/${mailtrapEmail}`,
      );
      expect(postNotificationResp.status).toBe(200);
      expect(postNotificationResp.data).toContain('Successfully subscribed.');

      const subject = 'AWS Notification - Subscription Confirmation';

      // Get email
      const mailtrapService: MailtrapApiClient = new MailtrapApiClient();
      const notificationResp: AxiosResponse<string, any> = await mailtrapService.getLatestMessageHTMLBySubject(
        mailtrapEmail,
        subject,
      );

      // Extract URL
      const urlRegex: RegExp = /(https:\/\/sns\.us-east-1\.amazonaws\.com[^"]*)/;
      const [, url] = notificationResp.data.match(urlRegex);

      // Extract token
      const tokenRegex: RegExp = /Token=([^&]*)/;
      const [, token] = url.match(tokenRegex);

      // Confirm subscription
      const confirmSubscriptionResp: ConfirmSubscriptionCommandOutput = await snsClient.send(
        new ConfirmSubscriptionCommand({
          TopicArn: topicSns,
          Token: token,
        }),
      );

      expect(confirmSubscriptionResp).toHaveProperty('SubscriptionArn');

      const getNotificationResp: AxiosResponse = await axios.get(`http://${ec2IpAddress}/api/notification`);
      expect(getNotificationResp.status).toBe(200);

      const notification: any = getNotificationResp.data.find((resp) => resp.Endpoint === mailtrapEmail);
      expect(notification.SubscriptionArn).toContain('cloudximage-TopicSNSTopic');
      expect(notification.Protocol).toBe('email');
      expect(notification.Endpoint).toBe(mailtrapEmail);
      expect(notification.TopicArn).toBe(topicSns);
    });

    test('the subscribed user receives notifications about images events (image is uploaded)', async () => {
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
      expect(typeof response.data.id).toBe('number');

      const subject = 'AWS Notification Message';
      const mailtrapService: MailtrapApiClient = new MailtrapApiClient();
      const notificationResp: AxiosResponse<string, any> = await mailtrapService.getLatestMessageTextBySubject(
        mailtrapEmail,
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

    test('the subscribed user receives notifications about images events (image is deleted)', async () => {
      const getImagesResponse: AxiosResponse = await axios.get(`http://${ec2IpAddress}/api/image`);
      expect(getImagesResponse.status).toBe(200);

      const imageIds: string[] = getImagesResponse.data.map((image) => image.id);

      if (!imageIds.length) throw new Error('There are no available image IDs');

      const randomImageId: string = _.sample(imageIds);

      const deleteImagesResponse: AxiosResponse = await axios.delete(
        `http://${ec2IpAddress}/api/image/${randomImageId}`,
      );
      expect(deleteImagesResponse.status).toBe(200);

      // Get email
      const subject = 'AWS Notification Message';
      const mailtrapService: MailtrapApiClient = new MailtrapApiClient();
      const notificationResp: AxiosResponse<string, any> = await mailtrapService.getLatestMessageTextBySubject(
        mailtrapEmail,
        subject,
      );
      const emailText: string = notificationResp.data;

      expect(emailText).toContain('event_type: delete');
      expect(emailText).toContain('object_key: images/');
      expect(emailText).toContain('object_type: binary/octet-stream');
      expect(emailText).toContain('last_modified: ');
      expect(emailText).toContain('object_size: ');
      expect(emailText).toContain('download_link:');
    });

    test('the user should view all existing subscriptions using {base URL}/notification GET API call', async () => {
      // Get subscriptions via API
      const response: AxiosResponse = await axios.get(`http://${ec2IpAddress}/api/notification`);
      expect(response.status).toBe(200);

      response.data.forEach((resp) => {
        expect(resp.SubscriptionArn).toBeDefined();
        expect(resp.SubscriptionArn).not.toBe('');

        expect(resp.Protocol).toBeDefined();
        expect(resp.Protocol).not.toBe('');

        expect(resp.Endpoint).toBeDefined();
        expect(resp.Endpoint).not.toBe('');

        expect(resp.TopicArn).toBeDefined();
        expect(resp.TopicArn).not.toBe('');
      });

      const subscriptionsFromApi: number = response.data.length;

      // Get subscriptions via AWS
      const listSubscriptionsResp: ListSubscriptionsByTopicCommandOutput = await snsClient.send(
        new ListSubscriptionsByTopicCommand({
          TopicArn: topicSns,
        }),
      );

      const subscriptionsFromAws: number = listSubscriptionsResp.Subscriptions.length;

      expect(subscriptionsFromApi).toBe(subscriptionsFromAws);
    });

    test('the user can download the image using the download link from the notification', async () => {
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
      expect(typeof response.data.id).toBe('number');

      // Get email
      const subject = 'AWS Notification Message';
      const mailtrapService: MailtrapApiClient = new MailtrapApiClient();
      const notificationResp: AxiosResponse<string, any> = await mailtrapService.getLatestMessageTextBySubject(
        mailtrapEmail,
        subject,
      );

      // Extract download URL
      const downloadUrlPattern: RegExp = /download_link:\s(.+)\n/;
      const [, downloadUrl] = notificationResp.data.match(downloadUrlPattern);

      try {
        const downloadImageResponse: AxiosResponse = await axios.get(downloadUrl, { responseType: 'blob' });
        expect(downloadImageResponse.status).toBe(200);
      } catch (error) {
        if (error instanceof Error) throw new Error(`${error}`);
      }
    });

    test('the user can unsubscribe from the notifications', async () => {
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
      expect(typeof response.data.id).toBe('number');

      // Get email
      const notificationSubject = 'AWS Notification Message';
      const mailtrapService: MailtrapApiClient = new MailtrapApiClient();
      const notificationResp: AxiosResponse<string, any> = await mailtrapService.getLatestMessageTextBySubject(
        mailtrapEmail,
        notificationSubject,
      );

      // Extract unsubscribe URL
      const unsubscribeUrlPattern: RegExp = /(http.*\/unsubscribe[^\s]+)/;
      const [, unsubscribeUrl] = notificationResp.data.match(unsubscribeUrlPattern);

      // Open browser
      const browser: Browser = await chromium.launch({ headless: false });
      const context: BrowserContext = await browser.newContext();
      const page: Page = await context.newPage();

      try {
        await page.goto(unsubscribeUrl, { timeout: 10_000, waitUntil: 'domcontentloaded' });
        await page.waitForSelector('h1#status', { state: 'visible' });
        const elementText: string = await page.locator('h1#status').textContent();
        expect(elementText).toContain('Subscription removed!');
      } catch (error) {
        if (error instanceof Error) throw new Error(`{error}`);
      } finally {
        await browser.close();
      }

      try {
        const unsubscribeSubject = 'AWS Notification - Unsubscribe Confirmation';
        const unsubscribeResp: AxiosResponse<string, any> = await mailtrapService.getLatestMessageHTMLBySubject(
          mailtrapEmail,
          unsubscribeSubject,
        );
        expect(unsubscribeResp.data).toContain('Your subscription to the topic below has been deactivated');
      } catch (error) {
        if (error instanceof Error) throw new Error(`${error}`);
      }
    });

    test('the unsubscribed user does not receive further notifications', async () => {
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
      expect(typeof response.data.id).toBe('number');

      try {
        const subject = 'AWS Notification Message';
        const mailtrapService: MailtrapApiClient = new MailtrapApiClient();
        await mailtrapService.getLatestMessageTextBySubject(mailtrapEmail, subject);
        throw new Error('The unsubscribed user still receives notifications');
      } catch (error) {
        if (error instanceof Error) throw new Error(`${error}`);
      }
    });
  });
});
