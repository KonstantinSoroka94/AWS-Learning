/* eslint-disable import/no-extraneous-dependencies */
import { CloudWatchClient, ListMetricsCommand, ListMetricsCommandOutput } from '@aws-sdk/client-cloudwatch';
import {
  CloudTrailClient,
  DescribeTrailsCommand,
  DescribeTrailsCommandOutput,
  GetTrailCommand,
  GetTrailCommandOutput,
  GetTrailStatusCommand,
  GetTrailStatusCommandOutput,
  ListTagsCommand,
  ListTagsCommandOutput,
  Trail,
} from '@aws-sdk/client-cloudtrail';
import {
  DescribeLogGroupsCommand,
  type DescribeLogGroupsCommandInput,
  type DescribeLogGroupsCommandOutput,
  type LogGroup,
  FilterLogEventsCommand,
  type FilteredLogEvent,
  CloudWatchLogsClient,
  DescribeLogStreamsCommandOutput,
  DescribeLogStreamsCommand,
  LogStream,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  DescribeInstancesCommand,
  type DescribeInstancesCommandInput,
  type DescribeInstancesCommandOutput,
  EC2Client,
} from '@aws-sdk/client-ec2';
import {
  ListTopicsCommand,
  type ListTopicsCommandOutput,
  SNSClient,
  SubscribeCommand,
  type SubscribeCommandInput,
  type SubscribeCommandOutput,
} from '@aws-sdk/client-sns';

import { describe, expect, test } from '@jest/globals';
import axios, { type AxiosResponse } from 'axios';
import _ from 'lodash';
import fs from 'fs-extra';
import { join } from 'path';
import FormData from 'form-data';
import { randomUUID } from 'node:crypto';
import { BaseConfig } from '../baseConfig';
import { wait } from '../commands/Common';

describe('Logging', () => {
  const { region } = BaseConfig;

  const cloudWatchLogsClient: CloudWatchLogsClient = new CloudWatchLogsClient({ region });

  const ec2Client: EC2Client = new EC2Client({ region });

  const snsClient: SNSClient = new SNSClient({ region });

  const cloudWatchClient: CloudWatchClient = new CloudWatchClient({ region });

  const cloudTrailClient: CloudTrailClient = new CloudTrailClient({ region });

  let ec2InstanceId: string = null;

  let ec2IpAddress: string = null;
  let topicSns: string = null;
  describe('MApplication validation', function () {
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

      const listTopicsResp: ListTopicsCommandOutput = await snsClient.send(new ListTopicsCommand({}));

      ({ TopicArn: topicSns } = listTopicsResp.Topics.find((topic) => {
        return topic.TopicArn.includes('cloudxserverless-TopicSNSTopic');
      }));

      if (!topicSns) throw new Error('There is no Topics ARN for the SNS');
    });

    test('checks if logs include required image information for each notification', async function () {
      const endpoint = `test+${randomUUID()}@example.com`;

      const params: SubscribeCommandInput = {
        Protocol: 'email',
        TopicArn: topicSns,
        Endpoint: endpoint,
      };

      const subscribeResp: SubscribeCommandOutput = await snsClient.send(new SubscribeCommand(params));
      expect(typeof subscribeResp.SubscriptionArn).toBe('string');

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
      expect(response.data.id).toBe('string');

      // Wait for event logs
      await wait(30_000);

      const logGroup: LogGroup = await getLatestLogGroup('/aws/lambda/cloudxserverless-EventHandlerLambda');

      const logEvents: FilteredLogEvent[] = await fetchLogEvents(logGroup.logGroupName);

      const logEventsMessages: string[] = logEvents.map(({ message }) => message);

      expect(logEventsMessages.some((message) => message.includes('object_key'))).toBe(true);
      expect(logEventsMessages.some((message) => message.includes('object_type'))).toBe(true);
      expect(logEventsMessages.some((message) => message.includes('last_modified'))).toBe(true);
      expect(logEventsMessages.some((message) => message.includes('object_size'))).toBe(true);
      expect(logEventsMessages.some((message) => message.includes('download_link'))).toBe(true);
    });

    test('checks if logs include HTTP API requests information', async function () {
      const randomImage: string = _.sample(['fire.jpg', 'lemon.jpg', 'workspace.jpg']);
      const filePath: string = join(process.cwd(), 'src', 'fixtures', randomImage);

      const formData: FormData = new FormData();
      formData.append('upfile', fs.createReadStream(filePath));

      const headers: { [key: string]: string } = {
        'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`,
        ...formData.getHeaders(),
      };

      const createResp: AxiosResponse = await axios.post(`http://${ec2IpAddress}/api/image`, formData, { headers });
      expect(createResp.status).toBe(200);

      const getResp: AxiosResponse = await axios.get(`http://${ec2IpAddress}/api/image`);
      expect(getResp.status).toBe(200);

      const imageIds: string[] = getResp.data.map((image) => image.id);
      const randomImageId: string = _.sample(imageIds);

      const deleteResp: AxiosResponse = await axios.delete(`http://${ec2IpAddress}/api/image/${randomImageId}`);
      expect(deleteResp.status).toBe(200);

      await wait(30_000);

      const logGroup: LogGroup = await getLatestLogGroup('/var/log/cloudxserverless-app');

      const logEvents: FilteredLogEvent[] = await fetchLogEvents(logGroup.logGroupName);

      const logEventsMessages: string[] = logEvents.map(({ message }) => message);

      expect(logEventsMessages.some((message) => message.includes('POST /api/image HTTP/1.1'))).toBe(true);
      expect(logEventsMessages.some((message) => message.includes('GET /api/image HTTP/1.1'))).toBe(true);
      expect(logEventsMessages.some((message) => message.includes('DELETE /api/image'))).toBe(true);
    });

    async function getLatestLogGroup(logGroupNamePrefix: string): Promise<LogGroup> {
      const params: DescribeLogGroupsCommandInput = {};
      let logGroups: LogGroup[] = [];
      let logGroupsData: DescribeLogGroupsCommandOutput = null;

      do {
        logGroupsData = await cloudWatchLogsClient.send(new DescribeLogGroupsCommand(params));
        logGroups = [...logGroups, ...logGroupsData.logGroups];
        params.nextToken = logGroupsData.nextToken;
      } while (logGroupsData.nextToken);

      const logGroup: LogGroup[] = logGroups
        .filter((group: LogGroup) => group.logGroupName.includes(logGroupNamePrefix))
        .sort((a: LogGroup, b: LogGroup) => b.creationTime - a.creationTime);

      return logGroup[0];
    }

    async function fetchLogEvents(logGroupName: string): Promise<Array<FilteredLogEvent>> {
      let logEvents: FilteredLogEvent[] = [];
      let nextToken: string;

      const thirtySecondsAgo = Date.now() - 1000 * 30;

      do {
        const logEventsData = await cloudWatchLogsClient.send(
          new FilterLogEventsCommand({
            logGroupName,
            nextToken,
            startTime: thirtySecondsAgo,
          }),
        );

        logEvents = [...logEvents, ...logEventsData.events];
        nextToken = logEventsData.nextToken;
      } while (nextToken);

      return logEvents;
    }
  });

  describe('Monitoring and logging application validation', function () {
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

      ({ InstanceId: ec2InstanceId } = ec2Instance.os);
    });

    test('the application EC2 instance should have CloudWatch integration', async () => {
      // Verify if metrics exist for EC2 instance
      const listMetricsData: ListMetricsCommandOutput = await cloudWatchClient.send(
        new ListMetricsCommand({
          Namespace: 'AWS/EC2',
          Dimensions: [
            {
              Name: 'InstanceId',
              Value: ec2InstanceId,
            },
          ],
        }),
      );

      expect(listMetricsData.Metrics).toBeDefined();
      const logGroupNames: string[] = await getLogGroupNames('/aws/lambda/cloudxserverless');

      expect(logGroupNames).toBeDefined();

      const allLogStreamsData: DescribeLogStreamsCommandOutput[] = await Promise.all(
        logGroupNames.map((logGroupName) => cloudWatchLogsClient.send(new DescribeLogStreamsCommand({ logGroupName }))),
      );

      allLogStreamsData
        .filter((logStreamsData: DescribeLogStreamsCommandOutput) => logStreamsData.logStreams.length)
        .forEach((logStreamsData: DescribeLogStreamsCommandOutput) => expect(logStreamsData.logStreams).toBeDefined());
    });

    test('CloudInit logs should be collected in CloudWatch logs', async () => {
      const logGroupNames: string[] = await getLogGroupNames('/var/log/cloud-init');

      expect(logGroupNames).toBeDefined();

      const streamData: DescribeLogStreamsCommandOutput = await cloudWatchLogsClient.send(
        new DescribeLogStreamsCommand({
          logGroupName: logGroupNames[0],
        }),
      );

      const now: number = Date.now();
      const SIXTY_MINUTES: number = 60 * 60 * 1000;
      const recentStream: Array<LogStream> = streamData.logStreams.filter((stream: LogStream) => {
        return now - stream.lastEventTimestamp <= SIXTY_MINUTES;
      });

      expect(recentStream).toBeDefined();
    });

    test('the application messages should be collected in CloudWatch logs', async () => {
      const logGroupNames: string[] = await getLogGroupNames('/var/log/messages');

      expect(logGroupNames).toBeDefined();

      const streamData: DescribeLogStreamsCommandOutput = await cloudWatchLogsClient.send(
        new DescribeLogStreamsCommand({
          logGroupName: logGroupNames[0],
        }),
      );

      expect(streamData.logStreams).toBeDefined();
    });

    test('the event handler logs should be collected in CloudWatch logs', async () => {
      const logGroupNames: string[] = await getLogGroupNames('/aws/lambda/cloudxserverless-EventHandlerLambda');

      expect(logGroupNames).toBeDefined();

      const allLogStreamsData: DescribeLogStreamsCommandOutput[] = await Promise.all(
        logGroupNames.map((logGroupName) => cloudWatchLogsClient.send(new DescribeLogStreamsCommand({ logGroupName }))),
      );

      allLogStreamsData
        .filter((logStreamsData: DescribeLogStreamsCommandOutput) => logStreamsData.logStreams.length)
        .forEach((logStreamsData: DescribeLogStreamsCommandOutput) => expect(logStreamsData.logStreams).toBeDefined());
    });

    test('CloudTrail should be enabled for Serverless stack and collects logs about AWS services access', async () => {
      const trailsData: DescribeTrailsCommandOutput = await cloudTrailClient.send(new DescribeTrailsCommand({}));

      const trailData: Trail = trailsData.trailList.find((trail: Trail) => {
        return trail.Name.includes('cloudxserverless-Trail');
      });

      expect(trailData.HomeRegion).toBe(region);
      expect(trailData.IncludeGlobalServiceEvents).toBe(true);
      expect(trailData.IsMultiRegionTrail).toBe(true);
      expect(trailData.IsOrganizationTrail).toBe(false);
      expect(trailData.LogFileValidationEnabled).toBe(true);

      const trailStatusData: GetTrailStatusCommandOutput = await cloudTrailClient.send(
        new GetTrailStatusCommand({ Name: trailData.TrailARN }),
      );

      expect(trailStatusData.IsLogging).toBe(true);
    });

    test('CloudWatch requirements (LogGroups)', async () => {
      const logGroupsData: DescribeLogGroupsCommandOutput = await cloudWatchLogsClient.send(
        new DescribeLogGroupsCommand({}),
      );

      const lambdaLogGroup: LogGroup = logGroupsData.logGroups.find((group: LogGroup) => {
        return group.logGroupName.startsWith('/aws/lambda/cloudxserverless-EventHandlerLambda');
      });

      expect(lambdaLogGroup).not.toBeNull();

      const applicationLogGroup: LogGroup = logGroupsData.logGroups.find((group) => {
        return group.logGroupName.includes('/var/log/cloudxserverless-app');
      });

      expect(applicationLogGroup).not.toBeNull();

      const streamData: DescribeLogStreamsCommandOutput = await cloudWatchLogsClient.send(
        new DescribeLogStreamsCommand({ logGroupName: applicationLogGroup.logGroupName }),
      );

      expect(streamData.logStreams).toBeDefined();

      const cloudInitLogGroup = logGroupsData.logGroups.find((group) => {
        return group.logGroupName === '/var/log/cloud-init';
      });

      expect(cloudInitLogGroup).not.toBeNull();
    });

    test('CloudTrail trail requirements', async () => {
      const trailsData: DescribeTrailsCommandOutput = await cloudTrailClient.send(new DescribeTrailsCommand({}));

      const trailData: Trail = trailsData.trailList.find((trail: Trail) => {
        return trail.Name.includes('cloudxserverless-Trail');
      });

      expect(trailData).toBeDefined();

      const getTrailCommand: GetTrailCommandOutput = await cloudTrailClient.send(
        new GetTrailCommand({ Name: trailData.Name }),
      );

      expect(getTrailCommand.Trail.IsMultiRegionTrail).toBe(true);

      expect(getTrailCommand.Trail.LogFileValidationEnabled).toBe(true);

      expect(trailData.KmsKeyId).toBeUndefined();

      const tagsData: ListTagsCommandOutput = await cloudTrailClient.send(
        new ListTagsCommand({ ResourceIdList: [trailData.TrailARN] }),
      );

      expect(tagsData.ResourceTagList[0].TagsList.find((tag) => tag.Key === 'cloudx').Value).toBe('qa');
    });

    async function getLogGroupNames(logGroupNamePrefix: string): Promise<Array<string>> {
      const params: DescribeLogGroupsCommandInput = {};
      let logGroups: LogGroup[] = [];
      let logGroupsData: DescribeLogGroupsCommandOutput = null;

      do {
        logGroupsData = await cloudWatchLogsClient.send(new DescribeLogGroupsCommand(params));
        logGroups = [...logGroups, ...logGroupsData.logGroups];
        params.nextToken = logGroupsData.nextToken;
      } while (logGroupsData.nextToken);

      return logGroups
        .filter((group: LogGroup) => group.logGroupName.includes(logGroupNamePrefix))
        .map(({ logGroupName }) => logGroupName);
    }
  });
});
