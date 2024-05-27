/* eslint-disable import/no-extraneous-dependencies */
import axios, { type AxiosResponse } from 'axios';
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  DescribeVolumesCommand,
  type DescribeInstancesCommandOutput,
  type DescribeVolumesCommandOutput,
  type DescribeSecurityGroupsCommandOutput,
  type SecurityGroup,
  type DescribeInstancesCommandInput,
} from '@aws-sdk/client-ec2';
import { describe, expect, test } from '@jest/globals';
import { BaseConfig } from '../BaseConfig';

describe('EC2', () => {
  const { region } = BaseConfig;

  const ec2: EC2Client = new EC2Client({
    region,
  });

  let deployedInstances: any[] = null;

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

    deployedInstances = data.Reservations.reduce((acc, reservation) => {
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
  });

  test('Should create two application instances', () => {
    expect(deployedInstances).toHaveLength(2);
  });

  test('Should return public instance configuration', () => {
    const publicInstance: any = deployedInstances.find((instance) => instance.type === 'public');

    expect(publicInstance.type).toBe('public');
    expect(publicInstance.instanceType).toBe('t2.micro');
    expect(publicInstance.tags.find((tag) => tag.Key === 'Name').Value).toBe('cloudxinfo/PublicInstance/Instance');
    expect(publicInstance.tags.find((tag) => tag.Key === 'cloudx').Value).toBe('qa');
    expect(publicInstance.os.PlatformDetails).toBe('Linux/UNIX');
    expect(publicInstance.os.PublicIpAddress).toBeDefined();
  });

  test('Should return private instance configuration', () => {
    const privateInstance: any = deployedInstances.find((instance) => instance.type === 'private');

    expect(privateInstance.type).toBe('private');
    expect(privateInstance.instanceType).toBe('t2.micro');
    expect(privateInstance.tags.find((tag) => tag.Key === 'Name').Value).toBe('cloudxinfo/PrivateInstance/Instance');
    expect(privateInstance.tags.find((tag) => tag.Key === 'cloudx').Value).toBe('qa');
    expect(privateInstance.os.PlatformDetails).toBe('Linux/UNIX');
    expect(privateInstance.os?.PublicIpAddress).toBeUndefined();
    expect(privateInstance.os.PrivateIpAddress).toBeDefined();
  });

  test('Should return public instances volumes', async () => {
    const instanceId: string = deployedInstances.find((instance) => instance.type === 'public').id;

    const params: DescribeInstancesCommandInput = {
      Filters: [
        {
          Name: 'attachment.instance-id',
          Values: [instanceId],
        },
      ],
    };

    const data: DescribeVolumesCommandOutput = await ec2.send(new DescribeVolumesCommand(params));

    expect(data.Volumes[0].Size).toBe(8);
    expect(data.Volumes[0].VolumeType).toBe('gp2');
  });

  test('Should return private instances volumes', async () => {
    const instanceId: string = deployedInstances.find((instance) => instance.type === 'private').id;

    const params: DescribeInstancesCommandInput = {
      Filters: [
        {
          Name: 'attachment.instance-id',
          Values: [instanceId],
        },
      ],
    };

    const data: DescribeVolumesCommandOutput = await ec2.send(new DescribeVolumesCommand(params));

    expect(data.Volumes[0].Size).toBe(8);
    expect(data.Volumes[0].VolumeType).toBe('gp2');
  });

  test(`Should return security groups configuration for the instances`, async () => {
    const publicSecurityGroupIds: any = deployedInstances
      .find((instance) => instance.type === 'public')
      .os.SecurityGroups.map((group) => group.GroupId);

    const publicSecurityGroups: DescribeSecurityGroupsCommandOutput = await ec2.send(
      new DescribeSecurityGroupsCommand({
        GroupIds: publicSecurityGroupIds,
      }),
    );

    const publicSecurityGroup: SecurityGroup = publicSecurityGroups.SecurityGroups[0];

    expect(publicSecurityGroup.IpPermissions).toContainEqual({
      FromPort: 80,
      IpProtocol: 'tcp',
      IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'HTTP from Internet' }],
      Ipv6Ranges: [],
      PrefixListIds: [],
      ToPort: 80,
      UserIdGroupPairs: [],
    });

    expect(publicSecurityGroup.IpPermissions).toContainEqual({
      FromPort: 22,
      IpProtocol: 'tcp',
      IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'SSH from Internet' }],
      Ipv6Ranges: [],
      PrefixListIds: [],
      ToPort: 22,
      UserIdGroupPairs: [],
    });

    const groupId: string = publicSecurityGroup.GroupId;
    const ownerId: string = publicSecurityGroup.OwnerId;

    const privateSecurityGroupIds: any = deployedInstances
      .find((instance) => instance.type === 'private')
      .os.SecurityGroups.map((group) => group.GroupId);

    const privateSecurityGroups: DescribeSecurityGroupsCommandOutput = await ec2.send(
      new DescribeSecurityGroupsCommand({
        GroupIds: privateSecurityGroupIds,
      }),
    );

    const privateSecurityGroup: SecurityGroup = privateSecurityGroups.SecurityGroups[0];

    expect(privateSecurityGroup.IpPermissions).toContainEqual({
      FromPort: 80,
      IpProtocol: 'tcp',
      IpRanges: [],
      Ipv6Ranges: [],
      PrefixListIds: [],
      ToPort: 80,
      UserIdGroupPairs: [{ Description: 'HTTP from Internet', GroupId: groupId, UserId: ownerId }],
    });

    expect(privateSecurityGroup.IpPermissions).toContainEqual({
      FromPort: 22,
      IpProtocol: 'tcp',
      IpRanges: [],
      Ipv6Ranges: [],
      PrefixListIds: [],
      ToPort: 22,
      UserIdGroupPairs: [{ Description: 'SSH from Internet', GroupId: groupId, UserId: ownerId }],
    });
  });

  test('Application API endpoint should return correct instance information', async () => {
    const publicInstance: any = deployedInstances.find((instance) => instance.type === 'public');

    const publicIpv4Address: string = publicInstance.os.PublicIpAddress;
    const privateIpv4Address: string = publicInstance.os.PrivateIpAddress;
    const availabilityZone: string = publicInstance.os.Placement.AvailabilityZone;

    const response: AxiosResponse = await axios.get(`http://${publicIpv4Address}`);

    expect(response.status).toBe(200);

    expect(response.data.availability_zone).toEqual(availabilityZone);
    expect(response.data.private_ipv4).toEqual(privateIpv4Address);
    expect(response.data.region).toEqual(region);
  });
});
