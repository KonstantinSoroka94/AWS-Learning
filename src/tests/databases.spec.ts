/* eslint-disable import/no-extraneous-dependencies */
import { type ForwardOptions, type SshOptions, type ServerOptions, type TunnelOptions, createTunnel } from 'tunnel-ssh';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { join } from 'path';
import { describe, expect, test } from '@jest/globals';
import {
  DescribeInstancesCommand,
  type DescribeInstancesCommandOutput,
  EC2Client,
  type DescribeInstancesCommandInput,
} from '@aws-sdk/client-ec2';
import {
  type DBInstance,
  DescribeDBInstancesCommand,
  type DescribeDBInstancesCommandOutput,
  RDSClient,
  VpcSecurityGroupMembership,
  Subnet,
} from '@aws-sdk/client-rds';
import axios, { type AxiosResponse } from 'axios';
import _ from 'lodash';
import fs, { readFileSync } from 'fs-extra';
import FormData from 'form-data';
import { BaseConfig } from '../BaseConfig';

describe('DataBases', () => {
  const { region, dbUsername, dbPassword, dbName, dbPort } = BaseConfig;

  const ec2Client: EC2Client = new EC2Client({ region });
  const rdsClient: RDSClient = new RDSClient({ region });

  const rdsPrefix: string = 'cloudximage-databasemysqlinstanced';

  let ec2IpAddress: string = null;
  let rdsEndpoint: string = null;

  describe('MySQL RDS connection via SSH tunnel', () => {
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
      if (!ec2Instance) throw new Error(`No public EC2 instance found`);
      ({ PublicIpAddress: ec2IpAddress } = ec2Instance.os);

      const command: DescribeDBInstancesCommand = new DescribeDBInstancesCommand({});
      const response: DescribeDBInstancesCommandOutput = await rdsClient.send(command);
      const rdsInstances: DBInstance[] = response.DBInstances;
      const rdsInstance: DBInstance = rdsInstances.find((rds) => rds.DBInstanceIdentifier.includes(rdsPrefix));
      if (!rdsInstance) throw new Error(`No MySQL RDS found with prefix: ${rdsPrefix}`);
      rdsEndpoint = rdsInstance.Endpoint.Address;
    });

    test('should connect to MySQL RDS and show tables', async () => {
      async function sshTunnel(sshOptions: SshOptions, port: number, autoClose = true): Promise<void> {
        const forwardOptions: ForwardOptions = {
          srcAddr: '127.0.0.1',
          srcPort: 3306,
          dstAddr: rdsEndpoint,
          dstPort: Number(dbPort),
        };

        const tunnelOptions: TunnelOptions = {
          autoClose,
        };

        const serverOptions: ServerOptions = {
          port,
        };

        await createTunnel(tunnelOptions, serverOptions, sshOptions, forwardOptions);
      }

      let connection: Connection = null;

      try {
        const options: SshOptions = {
          host: ec2IpAddress,
          username: 'ec2-user',
          privateKey: readFileSync(join(process.cwd(), 'credentials', 'cloudximage-us-east-1.pem'), 'utf8'),
          port: 22,
        };

        await sshTunnel(options, 3306);

        connection = await mysql.createConnection({
          host: '127.0.0.1',
          user: dbUsername,
          password: dbPassword,
          port: Number(dbPort),
          database: dbName,
        });
        const [rows] = await connection.query('SHOW TABLES;');
        expect(Array.isArray(rows)).toBeTruthy();
        expect(rows).not.toHaveLength(0);
      } catch (error) {
        if (error instanceof Error) throw new Error(`Failed to connect to ${rdsEndpoint}`);
      } finally {
        if (connection && connection.end) {
          await connection.end();
        }
      }
    });
  });

  describe('RDS deployment validation', () => {
    let rdsInstance: DBInstance = null;

    beforeAll(async () => {
      const command: DescribeDBInstancesCommand = new DescribeDBInstancesCommand({});
      const response: DescribeDBInstancesCommandOutput = await rdsClient.send(command);
      const rdsInstances: DBInstance[] = response.DBInstances;

      rdsInstance = rdsInstances.find((rds) => rds.DBInstanceIdentifier.includes(rdsPrefix));

      if (!rdsInstance) throw new Error(`No MySQL RDS found with prefix: ${rdsPrefix}`);
    });

    test('the MySQL RDS instance is deployed in the private subnet and accessible only from application subnet', async () => {
      expect(rdsInstance.VpcSecurityGroups.length).toBeGreaterThan(0);

      const securityGroup: VpcSecurityGroupMembership = rdsInstance.VpcSecurityGroups[0];
      expect(securityGroup.Status).toBe('active');
      expect(rdsInstance.PubliclyAccessible).toBe(false);
      expect(rdsInstance.DBSubnetGroup.VpcId).toBeDefined();
      expect(rdsInstance.DBSubnetGroup.DBSubnetGroupDescription).toBe('Subnet group for MySQLInstance database');

      const subnets: Subnet[] = rdsInstance.DBSubnetGroup.Subnets;
      expect(Array.isArray(subnets)).toBeTruthy();
      expect(subnets).not.toHaveLength(0);
      expect(subnets.every(({ SubnetStatus }) => SubnetStatus === 'Active')).toBe(true);

      let connection: Connection = null;
      rdsEndpoint = rdsInstance.Endpoint.Address;
      try {
        connection = await mysql.createConnection({
          host: rdsEndpoint,
          database: dbName,
          user: dbUsername,
          password: dbPassword,
          port: Number(dbPort),
        });

        await connection.execute('SHOW TABLES;');

        throw new Error(`Successfully connected to ${rdsInstance.DBInstanceIdentifier} at ${rdsEndpoint}.`);
      } catch (error) {
        if (error instanceof Error) {
          // eslint-disable-next-line jest/no-conditional-expect
          expect(JSON.stringify(error)).toBe('{"message":"connect ETIMEDOUT","code":"ETIMEDOUT"}');
        }
      } finally {
        if (connection && connection.end) {
          await connection.end();
        }
      }
    }, 60000);

    test('checks RDS MySQL instance properties', () => {
      expect(rdsInstance.DBInstanceClass).toBe('db.t3.micro');
      expect(rdsInstance.MultiAZ).toBe(false);
      expect(rdsInstance.AllocatedStorage).toBe(100);
      expect(rdsInstance.StorageType).toBe('gp2');
      expect(rdsInstance.StorageEncrypted).toBe(false);
      expect(rdsInstance.Engine).toBe('mysql');
      expect(rdsInstance.EngineVersion).toBe('8.0.32');
      expect(rdsInstance.TagList.find((tag) => tag.Key === 'cloudx').Value).toBe('qa');
    });
  });

  describe('RDS application functional validation', () => {
    let connection: Connection = null;

    let rdsTableName: string = null;
    let randomImageId: string = null;

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

      if (!ec2Instance) throw new Error(`No public EC2 instance found`);

      ({ PublicIpAddress: ec2IpAddress } = ec2Instance.os);

      const command: DescribeDBInstancesCommand = new DescribeDBInstancesCommand({});
      const response: DescribeDBInstancesCommandOutput = await rdsClient.send(command);
      const rdsInstances: DBInstance[] = response.DBInstances;

      const rdsInstance: DBInstance = rdsInstances.find((rds) => rds.DBInstanceIdentifier.includes(rdsPrefix));

      if (!rdsInstance) throw new Error(`No MySQL RDS found with prefix: ${rdsPrefix}`);

      rdsEndpoint = rdsInstance.Endpoint.Address;

      const options: SshOptions = {
        host: ec2IpAddress,
        username: 'ec2-user',
        privateKey: readFileSync(join(process.cwd(), 'src', 'credentials', 'cloudximage-eu-central-1.pem'), 'utf8'),
        port: 22,
      };

      async function sshTunnel(sshOptions: SshOptions, port: number, autoClose = true): Promise<void> {
        const forwardOptions: ForwardOptions = {
          srcAddr: '127.0.0.1',
          srcPort: 3306,
          dstAddr: rdsEndpoint,
          dstPort: Number(dbPort),
        };

        const tunnelOptions: TunnelOptions = {
          autoClose,
        };

        const serverOptions: ServerOptions = {
          port,
        };

        await createTunnel(tunnelOptions, serverOptions, sshOptions, forwardOptions);
      }

      await sshTunnel(options, 3306);

      connection = await mysql.createConnection({
        host: '127.0.0.1',
        user: dbUsername,
        password: dbPassword,
        port: 3306,
        database: dbName,
      });
    });

    afterAll(async () => {
      if (connection && connection.end) {
        await connection.end();
      }
    });

    test('the uploaded image metadata should be stored in MySQL RDS database', async () => {
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
      expect(typeof response.data.id).toBe('number');

      const [table] = await connection.query('SHOW TABLES;');
      rdsTableName = table?.[0]?.Tables_in_cloudximages;

      const [columns] = await connection.query(`SHOW COLUMNS FROM ${rdsTableName}`);
      const columnNames = (columns as RowDataPacket[]).map((column) => column.Field);
      expect(columnNames).toEqual(
        expect.arrayContaining(['id', 'object_key', 'object_type', 'last_modified', 'object_size']),
      );

      const [rows] = await connection.query(`SELECT COUNT(*) as count FROM ${rdsTableName};`);
      const rowCount = rows[0].count;
      expect(rowCount).toBeGreaterThan(0);

      const [images] = await connection.query('SELECT id FROM images;');
      const imageIds = (images as RowDataPacket[]).map((image) => image.id);
      expect(Array.isArray(imageIds)).toBeTruthy();
      expect(imageIds).not.toHaveLength(0);
      randomImageId = _.sample(imageIds);
    });

    it('the image metadata should be returned by {base URL}/image/{image_id} GET request', async () => {
      const response: AxiosResponse = await axios.get(`http://${ec2IpAddress}/api/image/${randomImageId}`);
      expect(response.status).toBe(200);
      expect(response.data.object_key).toBeDefined();
      expect(response.data.object_key).not.toBe('');

      expect(response.data.object_type).toBeDefined();
      expect(response.data.object_type).not.toBe('');

      expect(response.data.last_modified).toBeDefined();
      expect(response.data.last_modified).not.toBe('');

      expect(response.data.object_size.toString()).toBeDefined();
      expect(response.data.object_size.toString()).not.toBe('');
    });

    it('the image metadata for the deleted image should be deleted from the database', async () => {
      const response: AxiosResponse = await axios.delete(`http://${ec2IpAddress}/api/image/${randomImageId}`);
      expect(response.status).toBe(200);

      const [images] = await connection.query('SELECT id FROM images;');
      const imageIds = (images as RowDataPacket[]).map((image) => image.id);

      expect(imageIds).not.toContain(randomImageId);
    });
  });
});
