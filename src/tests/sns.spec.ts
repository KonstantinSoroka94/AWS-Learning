import {
  DescribeInstancesCommand,
  type DescribeInstancesCommandInput,
  type DescribeInstancesCommandOutput,
  EC2Client,
} from '@aws-sdk/client-ec2';
import axios, { AxiosResponse } from 'axios';
import { expect } from 'chai';
import {
  ConfirmSubscriptionCommand,
  ListTopicsCommand,
  type ListTopicsCommandOutput,
  SNSClient,
  type ListSubscriptionsByTopicCommandOutput,
  ListSubscriptionsByTopicCommand,
  type ConfirmSubscriptionCommandOutput,
} from '@aws-sdk/client-sns';
import { ListQueuesCommand, type ListQueuesCommandOutput, SQSClient } from '@aws-sdk/client-sqs';
import _ from 'lodash';
import { join } from 'path';
import { createReadStream } from 'fs-extra';
import FormData from 'form-data';
import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { BaseConfig } from '../../BaseConfig';
import { MailtrapApiClient } from '../../utilities/api/MailtrapApiClient';
import { generateMailtrapEmail, log } from '../../utilities/common';

describe('SNS/SQS application functional validation', function () {
  const { accessKeyId, secretAccessKey, region } = BaseConfig;

  const ec2: EC2Client = new EC2Client({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  const snsClient: SNSClient = new SNSClient({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  const sqsClient: SQSClient = new SQSClient({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  const mailtrapEmail: string = generateMailtrapEmail();

  const topicSnsPrefix = 'cloudximage-TopicSNSTopic';
  const queueSqsPrefix = 'cloudximage-QueueSQSQueue';

  let ec2IpAddress: string = null;

  let topicSns: string = null;
  let queueSqsUrl: string = null;

  before(async () => {
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

  it('the user can subscribe to notifications about application events via a provided email address', async () => {
    const email = `test+${randomUUID()}@example.com`;

    const response: AxiosResponse = await axios.post(`http://${ec2IpAddress}/api/notification/${email}`);
    expect(response.status, 'Post notification response status is not correct').to.equal(200);
    expect(response.data, 'Notification data is not correct').to.includes('Successfully subscribed.');
  });

  it('the user has to confirm the subscription after receiving the confirmation email', async () => {
    const postNotificationResp: AxiosResponse = await axios.post(
      `http://${ec2IpAddress}/api/notification/${mailtrapEmail}`,
    );
    expect(postNotificationResp.status, 'Post notification response status is not correct').to.equal(200);
    expect(postNotificationResp.data, 'Notification data is not correct').to.includes('Successfully subscribed.');

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

    expect(
      confirmSubscriptionResp,
      'There is no SubscriptionArn property in Confirm Subscription response',
    ).to.have.property('SubscriptionArn');

    const getNotificationResp: AxiosResponse = await axios.get(`http://${ec2IpAddress}/api/notification`);
    expect(getNotificationResp.status, 'Get notifications response status is not correct').to.equal(200);

    const notification: any = getNotificationResp.data.find((resp) => resp.Endpoint === mailtrapEmail);
    expect(notification.SubscriptionArn, 'SubscriptionArn is not correct').to.includes('cloudximage-TopicSNSTopic');
    expect(notification.Protocol, 'Protocol is not correct').to.equal('email');
    expect(notification.Endpoint, 'Endpoint is not correct').to.equal(mailtrapEmail);
    expect(notification.TopicArn, 'TopicArn is not correct').to.equal(topicSns);
  });

  it('the subscribed user receives notifications about images events (image is uploaded)', async () => {
    const randomImage: string = _.sample(['beach.jpg', 'coffee.jpg', 'tree.jpeg']);
    const filePath: string = join(process.cwd(), 'src', 'testData', randomImage);

    const formData: FormData = new FormData();
    formData.append('upfile', createReadStream(filePath));

    const headers: { [key: string]: string } = {
      'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`,
      ...formData.getHeaders(),
    };

    const response: AxiosResponse = await axios.post(`http://${ec2IpAddress}/api/image`, formData, { headers });
    expect(response.status, 'Post image response status is not correct').to.equal(200);
    expect(response.data.id, 'Image ID is not correct').to.be.an('number');

    // Get email
    const subject = 'AWS Notification Message';
    const mailtrapService: MailtrapApiClient = new MailtrapApiClient();
    const notificationResp: AxiosResponse<string, any> = await mailtrapService.getLatestMessageTextBySubject(
      mailtrapEmail,
      subject,
    );
    const emailText: string = notificationResp.data;

    expect(emailText, 'Email should include image upload event_type').to.includes('event_type: upload');
    expect(emailText, 'Email should include image upload object_key').to.includes('object_key: images/');
    expect(emailText, 'Email should include image upload object_type').to.includes('object_type: binary/octet-stream');
    expect(emailText, 'Email should include image upload last_modified').to.includes('last_modified: ');
    expect(emailText, 'Email should include image upload object_size').to.includes('object_size: ');
    expect(emailText, 'Email should include image upload download_link').to.includes('download_link: http://ec2');
  });

  it('the subscribed user receives notifications about images events (image is deleted)', async () => {
    const getImagesResponse: AxiosResponse = await axios.get(`http://${ec2IpAddress}/api/image`);
    expect(getImagesResponse.status, 'Get images response status is not correct').to.equal(200);

    const imageIds: string[] = getImagesResponse.data.map((image) => image.id);

    if (!imageIds.length) throw new Error('There are no available image IDs');

    const randomImageId: string = _.sample(imageIds);

    const deleteImagesResponse: AxiosResponse = await axios.delete(`http://${ec2IpAddress}/api/image/${randomImageId}`);
    expect(deleteImagesResponse.status, 'Delete image by ID response status is not correct').to.equal(200);

    // Get email
    const subject = 'AWS Notification Message';
    const mailtrapService: MailtrapApiClient = new MailtrapApiClient();
    const notificationResp: AxiosResponse<string, any> = await mailtrapService.getLatestMessageTextBySubject(
      mailtrapEmail,
      subject,
    );
    const emailText: string = notificationResp.data;

    expect(emailText, 'Email should include image delete event_type').to.includes('event_type: delete');
    expect(emailText, 'Email should include image delete object_key').to.includes('object_key: images/');
    expect(emailText, 'Email should include image delete object_type').to.includes('object_type: binary/octet-stream');
    expect(emailText, 'Email should include image delete last_modified').to.includes('last_modified: ');
    expect(emailText, 'Email should include image delete object_size').to.includes('object_size: ');
    expect(emailText, 'Email should include image delete download_link').to.includes('download_link:');
  });

  it('the user should view all existing subscriptions using {base URL}/notification GET API call', async () => {
    // Get subscriptions via API
    const response: AxiosResponse = await axios.get(`http://${ec2IpAddress}/api/notification`);
    expect(response.status, 'Get notifications response status is not correct').to.equal(200);

    response.data.forEach((resp) => {
      expect(resp.SubscriptionArn, 'SubscriptionArn is not present in response').to.exist.and.not.be.empty;
      expect(resp.Protocol, 'Protocol is not present in response').to.exist.and.not.be.empty;
      expect(resp.Endpoint, 'Endpoint is not present in response').to.exist.and.not.be.empty;
      expect(resp.TopicArn, 'TopicArn is not present in response').to.exist.and.not.be.empty;
    });

    const subscriptionsFromApi: number = response.data.length;

    // Get subscriptions via AWS
    const listSubscriptionsResp: ListSubscriptionsByTopicCommandOutput = await snsClient.send(
      new ListSubscriptionsByTopicCommand({
        TopicArn: topicSns,
      }),
    );

    const subscriptionsFromAws: number = listSubscriptionsResp.Subscriptions.length;

    expect(subscriptionsFromApi, 'Subscriptions from API is not equal to subscriptions from AWS').to.equal(
      subscriptionsFromAws,
    );
  });

  it('the user can download the image using the download link from the notification', async () => {
    const randomImage: string = _.sample(['beach.jpg', 'coffee.jpg', 'tree.jpeg']);
    const filePath: string = join(process.cwd(), 'src', 'testData', randomImage);

    const formData: FormData = new FormData();
    formData.append('upfile', createReadStream(filePath));

    const headers: { [key: string]: string } = {
      'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`,
      ...formData.getHeaders(),
    };

    const response: AxiosResponse = await axios.post(`http://${ec2IpAddress}/api/image`, formData, { headers });
    expect(response.status, 'Post image response status is not correct').to.equal(200);
    expect(response.data.id, 'Image ID is not correct').to.be.an('number');

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
      expect(downloadImageResponse.status, 'Download image response status is not correct').to.equal(200);
    } catch (error) {
      if (error instanceof Error) log(error.message);
      expect.fail('Cannot download the image');
    }
  });

  it('the user can unsubscribe from the notifications', async () => {
    const randomImage: string = _.sample(['beach.jpg', 'coffee.jpg', 'tree.jpeg']);
    const filePath: string = join(process.cwd(), 'src', 'testData', randomImage);

    const formData: FormData = new FormData();
    formData.append('upfile', createReadStream(filePath));

    const headers: { [key: string]: string } = {
      'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`,
      ...formData.getHeaders(),
    };

    const response: AxiosResponse = await axios.post(`http://${ec2IpAddress}/api/image`, formData, { headers });
    expect(response.status, 'Post image response status is not correct').to.equal(200);
    expect(response.data.id, 'Image ID is not correct').to.be.an('number');

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
      log(`Navigating to: ${unsubscribeUrl}`);
      await page.goto(unsubscribeUrl, { timeout: 10_000, waitUntil: 'domcontentloaded' });
      await page.waitForSelector('h1#status', { state: 'visible' });
      const elementText: string = await page.locator('h1#status').textContent();
      expect(elementText, 'Expected element text is not correct').to.includes('Subscription removed!');
    } catch (error) {
      if (error instanceof Error) log(`Error when navigating: ${error.message}`);
      expect.fail('Cannot open unsubscribe URL');
    } finally {
      await browser.close();
    }

    try {
      const unsubscribeSubject = 'AWS Notification - Unsubscribe Confirmation';
      const unsubscribeResp: AxiosResponse<string, any> = await mailtrapService.getLatestMessageHTMLBySubject(
        mailtrapEmail,
        unsubscribeSubject,
      );
      expect(unsubscribeResp.data).to.includes('Your subscription to the topic below has been deactivated');
    } catch (error) {
      if (error instanceof Error) log(error.message);
      expect.fail('User is not unsubscribed');
    }
  });

  it('the unsubscribed user does not receive further notifications', async () => {
    const randomImage: string = _.sample(['beach.jpg', 'coffee.jpg', 'tree.jpeg']);
    const filePath: string = join(process.cwd(), 'src', 'testData', randomImage);

    const formData: FormData = new FormData();
    formData.append('upfile', createReadStream(filePath));

    const headers: { [key: string]: string } = {
      'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`,
      ...formData.getHeaders(),
    };

    const response: AxiosResponse = await axios.post(`http://${ec2IpAddress}/api/image`, formData, { headers });
    expect(response.status, 'Post image response status is not correct').to.equal(200);
    expect(response.data.id, 'Image ID is not correct').to.be.an('number');

    try {
      const subject = 'AWS Notification Message';
      const mailtrapService: MailtrapApiClient = new MailtrapApiClient();
      await mailtrapService.getLatestMessageTextBySubject(mailtrapEmail, subject);
      expect.fail('The unsubscribed user still receives notifications');
    } catch (error) {
      if (error instanceof Error) log(error.message);
      log('The unsubscribed user does not receive further notifications');
    }
  });
});
