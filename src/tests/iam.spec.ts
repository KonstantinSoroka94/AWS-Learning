/* eslint-disable import/no-extraneous-dependencies */
import {
  IAMClient,
  GetRoleCommand,
  GetPolicyCommand,
  GetPolicyCommandOutput,
  GetPolicyVersionCommandOutput,
  GetPolicyVersionCommand,
  GetGroupCommand,
  GetGroupCommandOutput,
  ListAttachedGroupPoliciesCommandOutput,
  GetRoleCommandOutput,
  AttachedPolicy,
  ListAttachedGroupPoliciesCommand,
  GetUserCommand,
  GetUserCommandOutput,
  ListGroupsForUserCommandOutput,
  Group,
  ListGroupsForUserCommand,
} from '@aws-sdk/client-iam';
import { describe, expect, test } from '@jest/globals';
import { BaseConfig } from '../BaseConfig';

describe('IAM', () => {
  [
    {
      title: `Policy Should have FullAccessPolicyEC2 created, Role Should have FullAccessRoleEC2,
      Group Should have FullAccessGroupEC2 created,
      Users Should have FullAccessUserEC2 created with FullAccessGroupEC2 user group membership`,
      policyName: 'FullAccessPolicyEC2',
      roleName: 'FullAccessRoleEC2',
      groupName: 'FullAccessGroupEC2',
      userName: 'FullAccessUserEC2',
      expectedPolicy: [
        {
          Action: 'ec2:*',
          Effect: 'Allow',
          Resource: '*',
        },
      ],
      expectedPermissions: [
        {
          Action: 'ec2:*',
          Effect: 'Allow',
          Resource: '*',
        },
      ],
      expectedRole: [
        {
          Effect: 'Allow',
          Principal: { Service: 'ec2.amazonaws.com' },
          Action: 'sts:AssumeRole',
        },
      ],
    },
    {
      title: `Policy Should have FullAccessPolicyS3 created, Role Should have FullAccessRoleS3,
      Group Should have FullAccessGroupS3 created,
      Users Should have FullAccessUserS3 created with FullAccessGroupS3 user group membership`,
      policyName: 'FullAccessPolicyS3',
      roleName: 'FullAccessRoleS3',
      groupName: 'FullAccessGroupS3',
      userName: 'FullAccessUserS3',
      expectedPolicy: [
        {
          Action: 's3:*',
          Effect: 'Allow',
          Resource: '*',
        },
      ],
      expectedPermissions: [
        {
          Action: 's3:*',
          Effect: 'Allow',
          Resource: '*',
        },
      ],
      expectedRole: [
        {
          Effect: 'Allow',
          Principal: { Service: 'ec2.amazonaws.com' },
          Action: 'sts:AssumeRole',
        },
      ],
    },
    {
      title: `Policy Should have ReadAccessPolicyS3 created, Role Should have ReadAccessRoleS3,
      Group Should have ReadAccessGroupS3 created,
      Users Should have ReadAccessUserS3 created with ReadAccessGroupS3 user group membership`,
      policyName: 'ReadAccessPolicyS3',
      roleName: 'ReadAccessRoleS3',
      groupName: 'ReadAccessGroupS3',
      userName: 'ReadAccessUserS3',
      expectedPolicy: [
        {
          Action: ['s3:Describe*', 's3:Get*', 's3:List*'],
          Resource: '*',
          Effect: 'Allow',
        },
      ],
      expectedPermissions: [
        {
          Action: ['s3:Describe*', 's3:Get*', 's3:List*'],
          Effect: 'Allow',
          Resource: '*',
        },
      ],
      expectedRole: [
        {
          Effect: 'Allow',
          Principal: { Service: 'ec2.amazonaws.com' },
          Action: 'sts:AssumeRole',
        },
      ],
    },
  ].forEach(({ title, policyName, roleName, expectedPolicy, expectedRole, groupName, userName }) => {
    test(`${title}`, async () => {
      const { accountId, accessKeyId, secretAccessKey, region } = BaseConfig;
      const credentials = { accessKeyId, secretAccessKey, region };
      const iam: IAMClient = new IAMClient(credentials);

      // verify policy
      const POLICY_ARN = `arn:aws:iam::${accountId}:policy/${policyName}`;
      const policy: GetPolicyCommandOutput = await iam.send(
        new GetPolicyCommand({
          PolicyArn: POLICY_ARN,
        }),
      );
      const defaultPolicyVersionId: string = policy.Policy?.DefaultVersionId;
      const policyVersion: GetPolicyVersionCommandOutput = await iam.send(
        new GetPolicyVersionCommand({
          PolicyArn: POLICY_ARN,
          VersionId: defaultPolicyVersionId,
        }),
      );
      const decodedPolicyDocument: string = decodeURIComponent(policyVersion.PolicyVersion.Document);
      const actualPolicy: any = JSON.parse(decodedPolicyDocument).Statement;
      expect(actualPolicy).toEqual(expectedPolicy);

      //  verify role
      const role: GetRoleCommandOutput = await iam.send(
        new GetRoleCommand({
          RoleName: roleName,
        }),
      );
      expect(role.Role.RoleName).toEqual(roleName);
      expect(role.Role.Arn).toBe(`arn:aws:iam::${accountId}:role/${roleName}`);
      const decodedRoleDocument: string = decodeURIComponent(role.Role?.AssumeRolePolicyDocument);
      const actualRole: any = JSON.parse(decodedRoleDocument).Statement;
      expect(actualRole).toEqual(expectedRole);

      //  verify group
      const group: GetGroupCommandOutput = await iam.send(new GetGroupCommand({ GroupName: groupName }));
      expect(group.Group.GroupName).toEqual(groupName);
      expect(group.Group.Arn).toBe(`arn:aws:iam::${accountId}:group/${groupName}`);
      const attachedGroupPolicies: ListAttachedGroupPoliciesCommandOutput = await iam.send(
        new ListAttachedGroupPoliciesCommand({
          GroupName: groupName,
        }),
      );
      const actualGroupPolicy: AttachedPolicy[] = attachedGroupPolicies.AttachedPolicies.filter(
        (groupPolicy) => groupPolicy.PolicyName === policyName,
      );
      const expectedGroupPolicy = [
        {
          PolicyName: policyName,
          PolicyArn: `arn:aws:iam::${accountId}:policy/${policyName}`,
        },
      ];
      expect(actualGroupPolicy).toEqual(expectedGroupPolicy);

      //  verify user
      const user: GetUserCommandOutput = await iam.send(new GetUserCommand({ UserName: userName }));
      expect(user.User.UserName).toEqual(userName);
      expect(user.User.Arn).toBe(`arn:aws:iam::${accountId}:user/${userName}`);

      const groupsForUser: ListGroupsForUserCommandOutput = await iam.send(
        new ListGroupsForUserCommand({
          UserName: userName,
        }),
      );
      const groupNamesForUser: Group = groupsForUser.Groups.find((userGroup) => userGroup.GroupName === groupName);
      expect(groupNamesForUser.GroupName).toEqual(groupName);
      expect(groupNamesForUser.Arn).toBe(`arn:aws:iam::${accountId}:group/${groupName}`);
    });
  });
});
