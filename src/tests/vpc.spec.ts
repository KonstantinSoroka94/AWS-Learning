/* eslint-disable import/no-extraneous-dependencies */
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeRouteTablesCommand,
  DescribeInternetGatewaysCommand,
  Subnet,
  Vpc,
  type DescribeInstancesCommandOutput,
  type DescribeVpcsCommandOutput,
  type DescribeSubnetsCommandOutput,
  type DescribeInstancesCommandInput,
  type DescribeRouteTablesCommandOutput,
  type Route,
  type DescribeInternetGatewaysCommandOutput,
} from '@aws-sdk/client-ec2';
import { describe, expect, test } from '@jest/globals';
import { BaseConfig } from '../baseConfig';

describe('VPC', () => {
  const { region } = BaseConfig;
  let vpcId: string = null;
  const ec2Client: EC2Client = new EC2Client({
    region,
  });
  let publicSubnet: Subnet = null;
  let privateSubnet: Subnet = null;

  describe('Configuration', () => {
    beforeAll(async () => {
      const params: DescribeInstancesCommandInput = {
        Filters: [
          {
            Name: 'instance-state-name',
            Values: ['running'],
          },
        ],
      };
      const instances: DescribeInstancesCommandOutput = await ec2Client.send(new DescribeInstancesCommand(params));
      const deployedInstances: any[] = instances.Reservations.reduce((acc, reservation) => {
        return acc.concat(
          reservation.Instances.map((instance) => ({
            id: instance.InstanceId,
            type: instance.PublicIpAddress ? 'public' : 'private',
            os: instance,
          })),
        );
      }, []);

      vpcId = deployedInstances.find((instance) => instance.type === 'public').os.VpcId;
    });

    test("shouldn't be deployed in default VPC", async () => {
      const vpcs: DescribeVpcsCommandOutput = await ec2Client.send(new DescribeVpcsCommand({}));
      expect(vpcs.Vpcs).toHaveLength(2);
      const nonDefaultVpcs: Vpc[] = vpcs.Vpcs.filter((vpc) => !vpc.IsDefault);
      expect(nonDefaultVpcs).not.toHaveLength(0);
    });

    test('should have public and private subnets', async () => {
      const subnets: DescribeSubnetsCommandOutput = await ec2Client.send(
        new DescribeSubnetsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpcId] }] }),
      );
      expect(subnets.Subnets).toHaveLength(2);
      const subnetTags: string[] = subnets.Subnets.map(
        (subnet) => subnet.Tags.find(({ Key }) => Key === 'aws-cdk:subnet-type')?.Value,
      );
      expect(subnetTags).toEqual(expect.arrayContaining(['Public', 'Private']));
    });

    test('should have valid CIDR block', async () => {
      const vpcs: DescribeVpcsCommandOutput = await ec2Client.send(
        new DescribeVpcsCommand({
          VpcIds: [vpcId],
        }),
      );
      expect(vpcs.Vpcs[0].CidrBlock).toBe('10.0.0.0/16');
    });

    test('should have cloudx tags and name', async () => {
      const vpcs: DescribeVpcsCommandOutput = await ec2Client.send(
        new DescribeVpcsCommand({
          VpcIds: [vpcId],
        }),
      );
      expect(vpcs.Vpcs[0].Tags.find(({ Key }) => Key === 'Name').Value).toBe('cloudxinfo/Network/Vpc');
      expect(vpcs.Vpcs[0].Tags.find(({ Key }) => Key === 'cloudx').Value).toBe('qa');
    });
  });

  describe('Subnets and routing', () => {
    beforeAll(async () => {
      const subnets: DescribeSubnetsCommandOutput = await ec2Client.send(new DescribeSubnetsCommand({}));

      publicSubnet = subnets.Subnets.filter(({ Tags }) => Tags).find((subnet) =>
        subnet.Tags.find(({ Key, Value }) => Key === 'aws-cdk:subnet-name' && Value === 'PublicSubnet'),
      );

      privateSubnet = subnets.Subnets.filter(({ Tags }) => Tags).find((subnet) =>
        subnet.Tags.find(({ Key, Value }) => Key === 'aws-cdk:subnet-name' && Value === 'PrivateSubnet'),
      );
    });

    test('The public instance should be accessible from the internet by Internet Gateway.', async () => {
      expect(publicSubnet.SubnetId).toBeDefined();

      const routeTablesResult: DescribeRouteTablesCommandOutput = await ec2Client.send(
        new DescribeRouteTablesCommand({
          Filters: [{ Name: 'association.subnet-id', Values: [publicSubnet.SubnetId] }],
        }),
      );
      const internetRoute: Route = routeTablesResult.RouteTables[0].Routes.find(
        (route) => route.DestinationCidrBlock === '0.0.0.0/0',
      );
      expect(internetRoute).toBeDefined();
      expect(internetRoute.GatewayId).toMatch(/^igw-/);
      const internetGatewaysResult: DescribeInternetGatewaysCommandOutput = await ec2Client.send(
        new DescribeInternetGatewaysCommand({
          Filters: [{ Name: 'internet-gateway-id', Values: [internetRoute.GatewayId] }],
        }),
      );
      expect(internetGatewaysResult.InternetGateways).toBeDefined();
      expect(internetGatewaysResult.InternetGateways[0].Attachments[0].State).toBe('available');
      expect(internetGatewaysResult.InternetGateways[0].Attachments[0].VpcId).toEqual(publicSubnet.VpcId);
    });

    test('public and private subnets should be in the same VPC', () => {
      expect(publicSubnet.VpcId).toEqual(privateSubnet.VpcId);
    });

    test('The public instance should have access to the private instance.', async () => {
      const routeTablesResult: DescribeRouteTablesCommandOutput = await ec2Client.send(
        new DescribeRouteTablesCommand({
          Filters: [{ Name: 'vpc-id', Values: [publicSubnet.VpcId] }],
        }),
      );

      routeTablesResult.RouteTables.forEach((routeTable) => {
        const localRoute = routeTable.Routes.find((route) => route.GatewayId === 'local');
        expect(localRoute).toBeDefined();
      });
    });

    test('The private instance should have access to the internet via NAT Gateway.', async () => {
      const routeTables: DescribeRouteTablesCommandOutput = await ec2Client.send(
        new DescribeRouteTablesCommand({
          Filters: [{ Name: 'association.subnet-id', Values: [privateSubnet.SubnetId] }],
        }),
      );
      const internetRoute: Route = routeTables.RouteTables[0].Routes.find(
        (route) => route.DestinationCidrBlock === '0.0.0.0/0',
      );
      expect(internetRoute).toBeDefined();
      expect(internetRoute.NatGatewayId).toMatch(/^nat-/);
    });

    test('The private instance should not be accessible from the public internet.', async () => {
      const routeTables: DescribeRouteTablesCommandOutput = await ec2Client.send(
        new DescribeRouteTablesCommand({
          Filters: [{ Name: 'association.subnet-id', Values: [privateSubnet.SubnetId] }],
        }),
      );
      const internetRoute: Route = routeTables.RouteTables[0].Routes.find(
        (route) => route.DestinationCidrBlock === '0.0.0.0/0',
      );
      expect(internetRoute.NatGatewayId).not.toMatch(/^igw-/);
    });
  });
});
